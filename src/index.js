#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { glob } = require('glob');

const isCI = !!process.env.GITHUB_ACTIONS;

async function main() {
  const testFilePattern = process.env.INPUT_TEST_FILE || process.argv[2];
  if (!testFilePattern) {
    console.error('Usage: claude-skill-test <test-file.yaml>');
    console.error('  Or set INPUT_TEST_FILE environment variable');
    process.exit(1);
  }

  const configFile = process.env.INPUT_CLAUDE_CODE_CONFIG || '';
  const maxTurns = process.env.INPUT_MAX_TURNS || '3';
  const timeoutSec = parseInt(process.env.INPUT_TIMEOUT || '60', 10);
  const modelOverride = process.env.INPUT_MODEL || '';

  // Configure alternative model providers
  const useBedrock = process.env.INPUT_USE_BEDROCK === 'true';
  const bedrockAwsRegion = process.env.INPUT_BEDROCK_AWS_REGION || '';
  const useVertex = process.env.INPUT_USE_VERTEX === 'true';
  const vertexProjectId = process.env.INPUT_VERTEX_PROJECT_ID || '';
  const vertexRegion = process.env.INPUT_VERTEX_REGION || '';
  const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || '';

  const usingAlternativeProvider = useBedrock || useVertex || !!anthropicBaseUrl;
  if (!process.env.ANTHROPIC_API_KEY && !usingAlternativeProvider) {
    console.error('ANTHROPIC_API_KEY environment variable is required when not using Bedrock, Vertex, or a custom base URL');
    process.exit(1);
  }

  if (useBedrock) {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    if (bedrockAwsRegion) process.env.AWS_REGION = bedrockAwsRegion;
    console.log(`Provider: AWS Bedrock${bedrockAwsRegion ? ` (region: ${bedrockAwsRegion})` : ''}`);
  } else if (useVertex) {
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    if (vertexProjectId) process.env.ANTHROPIC_VERTEX_PROJECT_ID = vertexProjectId;
    if (vertexRegion) process.env.CLOUD_ML_REGION = vertexRegion;
    console.log(`Provider: Google Vertex AI (project: ${vertexProjectId}, region: ${vertexRegion})`);
  } else if (anthropicBaseUrl) {
    console.log(`Provider: Custom endpoint (${anthropicBaseUrl})`);
  } else {
    console.log('Provider: Anthropic API (direct)');
  }

  if (configFile && fs.existsSync(configFile)) {
    mergeClaudeConfig(configFile);
  }

  const testFiles = await glob(testFilePattern);
  if (testFiles.length === 0) {
    console.error(`No test files matched: ${testFilePattern}`);
    process.exit(1);
  }

  const allResults = [];
  let allPassed = true;

  for (const testFile of testFiles) {
    console.log(`\nLoading ${testFile}`);
    const manifest = yaml.load(fs.readFileSync(testFile, 'utf8'));
    const { skill: targetSkill, agent: targetAgent, model: manifestModel = 'sonnet', tests } = manifest;
    const model = modelOverride || manifestModel;

    if (targetSkill) console.log(`  Skill: ${targetSkill}`);
    if (targetAgent) console.log(`  Agent: ${targetAgent}`);
    console.log(`  Model: ${model}`);
    console.log(`  Tests: ${tests.length}\n`);

    const results = [];

    for (const test of tests) {
      const result = await runTest({ test, targetSkill, targetAgent, model, maxTurns, timeoutSec });
      results.push(result);

      const icon = result.pass ? 'PASS' : 'FAIL';
      console.log(`  [${icon}] ${result.id} - "${truncate(result.prompt, 50)}"`);

      if (result.skillsInvoked.length > 0) {
        console.log(`         skills invoked: [${result.skillsInvoked.join(', ')}]`);
      }
      if (result.agentsInvoked.length > 0) {
        console.log(`         agents invoked: [${result.agentsInvoked.join(', ')}]`);
      }
      if (result.toolsUsed.length > 0) {
        console.log(`         tools used: [${result.toolsUsed.join(', ')}]`);
      }

      if (!result.pass) {
        allPassed = false;
        if (!result.skillPass) {
          const expected = result.should_trigger ? 'trigger' : 'skip';
          const actual = result.triggered ? 'trigger' : 'skip';
          console.log(`         skill: expected ${expected}, got ${actual}`);
        }
        if (!result.agentPass) {
          const expected = result.should_trigger ? 'trigger' : 'skip';
          const actual = result.agentTriggered ? 'trigger' : 'skip';
          console.log(`         agent: expected ${expected}, got ${actual}`);
        }
        if (!result.toolsPass) {
          console.log(`         tools: expected [${result.expected_tools.join(', ')}], got [${result.toolsUsed.join(', ')}]`);
        }
        if (result.error) {
          console.log(`         error: ${result.error}`);
        }
      }

      // Show Claude Code transcript for this test
      logTranscript(result);
    }

    allResults.push({ targetSkill, targetAgent, model, results });
  }

  const summary = formatSummary(allResults);
  console.log('\n' + summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }

  const outputPath = process.env.INPUT_OUTPUT_FILE || 'skill-test-results.json';
  fs.writeFileSync(outputPath, JSON.stringify(allResults, null, 2));
  console.log(`Results written to ${outputPath}`);

  if (!allPassed) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Transcript logging - show Claude Code output per test
// ---------------------------------------------------------------------------

function logTranscript(result) {
  const { id, pass, transcript } = result;
  if (!transcript || transcript.length === 0) return;

  // Collapse passing transcripts, show failing ones directly
  if (isCI) {
    if (pass) {
      console.log(`::group::Transcript: ${id}`);
    } else {
      console.log(`         transcript:`);
    }
  } else {
    console.log(`\n  --- transcript: ${id} ---`);
  }

  for (const entry of transcript) {
    switch (entry.type) {
      case 'init':
        console.log(`  [init] model=${entry.model}, tools=${entry.toolCount}, skills=${entry.skillCount}`);
        if (entry.skills.length > 0) {
          console.log(`         available skills: ${entry.skills.slice(0, 20).join(', ')}${entry.skills.length > 20 ? '...' : ''}`);
        }
        break;
      case 'text':
        console.log(`  [assistant] ${truncate(entry.text, 200)}`);
        break;
      case 'tool_use':
        console.log(`  [tool_use] ${entry.name}(${formatToolInput(entry.input)})`);
        break;
      case 'tool_result':
        console.log(`  [tool_result] ${truncate(entry.text, 200)}`);
        break;
      case 'result':
        console.log(`  [result] cost=$${entry.cost?.toFixed(4) || '?'}, turns=${entry.turns || '?'}, stop=${entry.stopReason || '?'}`);
        break;
      case 'error':
        console.log(`  [error] ${entry.text}`);
        break;
    }
  }

  if (isCI) {
    if (pass) {
      console.log('::endgroup::');
    }
  } else {
    console.log('  --- end transcript ---\n');
  }
}

function formatToolInput(input) {
  if (!input) return '';
  const entries = Object.entries(input);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => {
    const val = typeof v === 'string' ? truncate(v, 60) : JSON.stringify(v);
    return `${k}=${val}`;
  }).join(', ');
}

// ---------------------------------------------------------------------------
// Config merging
// ---------------------------------------------------------------------------

function mergeClaudeConfig(configFile) {
  console.log(`Merging config from ${configFile}`);
  const userConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));

  const settingsDir = path.join(process.env.HOME, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');

  fs.mkdirSync(settingsDir, { recursive: true });

  let existing = {};
  if (fs.existsSync(settingsPath)) {
    existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }

  const merged = deepMerge(existing, userConfig);
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (isPlainObject(source[key]) && isPlainObject(target[key])) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function runTest({ test, targetSkill, targetAgent, model, maxTurns, timeoutSec }) {
  const { id, prompt, should_trigger, expected_tools = [], notes } = test;

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', maxTurns,
    '--model', model,
    '--dangerously-skip-permissions',
  ];

  console.log(`         running: claude ${args.join(' ')}`);

  let stdout = '';
  let stderr = '';
  let error = null;

  try {
    const result = await spawnClaude(args, timeoutSec);
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    error = err.message;
  }

  // Log stderr if present - critical for debugging CI issues
  if (stderr.trim()) {
    console.log(`         [stderr] ${truncate(stderr.trim(), 500)}`);
  }

  const { skillsInvoked, toolsUsed, agentsInvoked, transcript } = parseStreamJson(stdout);

  const triggered = targetSkill ? skillsInvoked.includes(targetSkill) : false;
  const skillPass = targetSkill ? (triggered === should_trigger) : true;

  const agentTriggered = targetAgent ? agentsInvoked.includes(targetAgent) : false;
  const agentPass = targetAgent ? (agentTriggered === should_trigger) : true;

  let toolsPass = true;
  if (expected_tools.length > 0 && should_trigger) {
    toolsPass = expected_tools.every(t => toolsUsed.includes(t));
  }

  return {
    id,
    prompt,
    should_trigger,
    triggered,
    agentTriggered,
    skillPass,
    agentPass,
    toolsPass,
    expected_tools,
    toolsUsed,
    skillsInvoked,
    agentsInvoked,
    pass: skillPass && agentPass && toolsPass,
    error,
    notes,
    transcript,
  };
}

// ---------------------------------------------------------------------------
// Claude CLI interaction
// ---------------------------------------------------------------------------

function spawnClaude(args, timeoutSec) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    // Close stdin so claude doesn't block waiting for input
    const proc = spawn('claude', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    function rejectWithOutput(message) {
      const err = new Error(message);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    }

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      rejectWithOutput(`Timed out after ${timeoutSec}s`);
    }, timeoutSec * 1000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        rejectWithOutput(`claude exited with code ${code}: ${stderr}`);
      } else {
        resolve({ stdout, stderr });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      rejectWithOutput(`Failed to spawn claude: ${err.message}`);
    });
  });
}

// ---------------------------------------------------------------------------
// Output parsing - extracts tool invocations AND builds a readable transcript
// ---------------------------------------------------------------------------

function parseStreamJson(stdout) {
  const skillsInvoked = [];
  const toolsUsed = [];
  const agentsInvoked = [];
  const transcript = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Build transcript from events
    extractTranscriptEntry(event, transcript);

    // Collect tool uses
    collectToolUses(event, skillsInvoked, toolsUsed, agentsInvoked);
  }

  return {
    skillsInvoked: [...new Set(skillsInvoked)],
    toolsUsed: [...new Set(toolsUsed)],
    agentsInvoked: [...new Set(agentsInvoked)],
    transcript,
  };
}

function extractTranscriptEntry(event, transcript) {
  if (!event || !event.type) return;

  // System init - captures available tools and skills
  if (event.type === 'system' && event.subtype === 'init') {
    transcript.push({
      type: 'init',
      model: event.model || '?',
      toolCount: event.tools?.length || 0,
      skillCount: event.skills?.length || 0,
      skills: event.skills || [],
      tools: event.tools || [],
    });
    return;
  }

  // Assistant messages - extract text and tool_use blocks
  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text) {
        transcript.push({ type: 'text', text: block.text });
      }
      if (block.type === 'tool_use') {
        transcript.push({ type: 'tool_use', name: block.name, input: block.input });
      }
      if (block.type === 'tool_result') {
        const text = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content || '').slice(0, 300);
        transcript.push({ type: 'tool_result', text });
      }
    }

    // Also check for error field on the message event
    if (event.error) {
      transcript.push({ type: 'error', text: event.error });
    }
    return;
  }

  // Result event - final summary
  if (event.type === 'result') {
    transcript.push({
      type: 'result',
      cost: event.total_cost_usd,
      turns: event.num_turns,
      stopReason: event.stop_reason,
      resultText: typeof event.result === 'string' ? event.result.slice(0, 300) : '',
    });
    return;
  }
}

function collectToolUses(obj, skillsInvoked, toolsUsed, agentsInvoked) {
  if (!obj || typeof obj !== 'object') return;

  if (obj.type === 'tool_use' && obj.name) {
    toolsUsed.push(obj.name);
    if (obj.name === 'Skill' && obj.input?.skill) {
      skillsInvoked.push(obj.input.skill);
    }
    if (obj.name === 'Task' && obj.input?.subagent_type) {
      agentsInvoked.push(obj.input.subagent_type);
    }
  }

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectToolUses(item, skillsInvoked, toolsUsed, agentsInvoked);
      }
    } else if (isPlainObject(value)) {
      collectToolUses(value, skillsInvoked, toolsUsed, agentsInvoked);
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatSummary(allResults) {
  let md = '';
  let totalPassed = 0;
  let totalTests = 0;

  for (const { targetSkill, targetAgent, model, results } of allResults) {
    const target = [targetSkill, targetAgent].filter(Boolean).map(s => `\`${s}\``).join(' / ');
    md += `## Target: ${target} (model: ${model})\n\n`;
    md += '| Test ID | Prompt | Expected | Skill | Agent | Tools | Result |\n';
    md += '|---------|--------|----------|-------|-------|-------|--------|\n';

    for (const r of results) {
      totalTests++;
      if (r.pass) totalPassed++;

      const prompt = truncate(r.prompt, 30);
      const expected = r.should_trigger ? 'trigger' : 'skip';
      const skill = targetSkill
        ? (r.skillPass ? 'PASS' : 'FAIL')
        : '-';
      const agent = targetAgent
        ? (r.agentPass ? 'PASS' : 'FAIL')
        : '-';
      const tools = r.expected_tools.length > 0
        ? (r.toolsPass ? 'PASS' : 'FAIL')
        : '-';
      const result = r.pass ? 'PASS' : 'FAIL';

      md += `| ${r.id} | "${prompt}" | ${expected} | ${skill} | ${agent} | ${tools} | ${result} |\n`;
    }

    md += '\n';
  }

  md += `**Results: ${totalPassed}/${totalTests} passed**\n`;
  return md;
}

function truncate(str, len) {
  if (str.length <= len) return str;
  return str.slice(0, len - 1) + '\u2026';
}

// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
