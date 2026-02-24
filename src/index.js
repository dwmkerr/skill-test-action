#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { glob } = require('glob');

async function main() {
  const testFilePattern = process.env.INPUT_TEST_FILE || process.argv[2];
  if (!testFilePattern) {
    console.error('Usage: claude-skill-test <test-file.yaml>');
    console.error('  Or set INPUT_TEST_FILE environment variable');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  const configFile = process.env.INPUT_CLAUDE_CODE_CONFIG || '';
  const maxTurns = process.env.INPUT_MAX_TURNS || '3';
  const timeoutSec = parseInt(process.env.INPUT_TIMEOUT || '60', 10);
  const modelOverride = process.env.INPUT_MODEL || '';

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
    const { skill: targetSkill, model: manifestModel = 'sonnet', tests } = manifest;
    const model = modelOverride || manifestModel;

    console.log(`  Skill: ${targetSkill}`);
    console.log(`  Model: ${model}`);
    console.log(`  Tests: ${tests.length}\n`);

    const results = [];

    for (const test of tests) {
      const result = await runTest({ test, targetSkill, model, maxTurns, timeoutSec });
      results.push(result);

      const icon = result.pass ? 'PASS' : 'FAIL';
      console.log(`  [${icon}] ${result.id} - "${truncate(result.prompt, 50)}"`);

      if (!result.pass) {
        allPassed = false;
        if (!result.skillPass) {
          const expected = result.should_trigger ? 'trigger' : 'skip';
          const actual = result.triggered ? 'trigger' : 'skip';
          console.log(`         skill: expected ${expected}, got ${actual}`);
        }
        if (!result.toolsPass) {
          console.log(`         tools: expected [${result.expected_tools.join(', ')}], got [${result.toolsUsed.join(', ')}]`);
        }
        if (result.error) {
          console.log(`         error: ${result.error}`);
        }
      }
    }

    allResults.push({ targetSkill, model, results });
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

async function runTest({ test, targetSkill, model, maxTurns, timeoutSec }) {
  const { id, prompt, should_trigger, expected_tools = [], notes } = test;

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', maxTurns,
    '--model', model,
  ];

  let stdout = '';
  let error = null;

  try {
    const result = await spawnClaude(args, timeoutSec);
    stdout = result.stdout;
  } catch (err) {
    // Still parse any partial output captured before the error/timeout
    stdout = err.stdout || '';
    error = err.message;
  }

  const { skillsInvoked, toolsUsed } = parseStreamJson(stdout);

  const triggered = skillsInvoked.includes(targetSkill);
  const skillPass = triggered === should_trigger;

  let toolsPass = true;
  if (expected_tools.length > 0 && should_trigger) {
    toolsPass = expected_tools.every(t => toolsUsed.includes(t));
  }

  return {
    id,
    prompt,
    should_trigger,
    triggered,
    skillPass,
    toolsPass,
    expected_tools,
    toolsUsed,
    skillsInvoked,
    pass: skillPass && toolsPass,
    error,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Claude CLI interaction
// ---------------------------------------------------------------------------

function spawnClaude(args, timeoutSec) {
  return new Promise((resolve, reject) => {
    // Remove CLAUDECODE to allow running from within a Claude Code session
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = spawn('claude', args, { env });

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
// Output parsing
// ---------------------------------------------------------------------------

function parseStreamJson(stdout) {
  const skillsInvoked = [];
  const toolsUsed = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    collectToolUses(event, skillsInvoked, toolsUsed);
  }

  return {
    skillsInvoked: [...new Set(skillsInvoked)],
    toolsUsed: [...new Set(toolsUsed)],
  };
}

function collectToolUses(obj, skillsInvoked, toolsUsed) {
  if (!obj || typeof obj !== 'object') return;

  // Detect tool_use content blocks (nested in assistant messages)
  if (obj.type === 'tool_use' && obj.name) {
    toolsUsed.push(obj.name);
    if (obj.name === 'Skill' && obj.input?.skill) {
      skillsInvoked.push(obj.input.skill);
    }
  }

  // Recurse into all values
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectToolUses(item, skillsInvoked, toolsUsed);
      }
    } else if (isPlainObject(value)) {
      collectToolUses(value, skillsInvoked, toolsUsed);
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

  for (const { targetSkill, model, results } of allResults) {
    md += `## Skill: \`${targetSkill}\` (model: ${model})\n\n`;
    md += '| Test ID | Prompt | Expected | Actual | Tools | Result |\n';
    md += '|---------|--------|----------|--------|-------|--------|\n';

    for (const r of results) {
      totalTests++;
      if (r.pass) totalPassed++;

      const prompt = truncate(r.prompt, 30);
      const expected = r.should_trigger ? 'trigger' : 'skip';
      const actual = r.triggered ? 'trigger' : 'skip';
      const tools = r.expected_tools.length > 0
        ? (r.toolsPass ? 'PASS' : 'FAIL')
        : '-';
      const result = r.pass ? 'PASS' : 'FAIL';

      md += `| ${r.id} | "${prompt}" | ${expected} | ${actual} | ${tools} | ${result} |\n`;
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
