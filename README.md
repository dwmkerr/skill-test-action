# skill-test-action

GitHub Action to test Claude Code skill routing with declarative YAML manifests.

## Demo

See [dwmkerr/claude-toolkit](https://github.com/dwmkerr/claude-toolkit) for a working example of this action in use.

## Usage

```yaml
- uses: dwmkerr/skill-test-action@main
  with:
    test_file: tests/skill-tests.yaml
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    marketplaces: dwmkerr/claude-toolkit
    plugins: toolkit@claude-toolkit
```

The test file should be named `skill-tests.yaml` (conventionally placed in a `tests/` directory).

## Test Manifest

Test skill invocations (via `Skill` tool):

```yaml
skill: toolkit:skill-development
model: haiku

tests:
  - id: explicit-create-skill
    prompt: "I want to create a new skill"
    should_trigger: true

  - id: negative-control
    prompt: "fix the typo on line 12"
    should_trigger: false
```

Test agent invocations (via `Task` tool with `subagent_type`):

```yaml
agent: exploration-protocol-orchestrator
model: haiku

tests:
  - id: explore-feature
    prompt: "explore the authentication feature"
    should_trigger: true
```

You can also specify both `skill` and `agent` in the same manifest to test that a prompt triggers both.

## Inputs

```yaml
- uses: dwmkerr/skill-test-action@main
  with:
    # Path to YAML test manifest - required
    # Convention: tests/skill-tests.yaml (supports glob patterns)
    test_file: tests/skill-tests.yaml

    # Anthropic API key - required
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}

    # Space-separated marketplace repos to add (owner/repo format) - optional
    # marketplaces: dwmkerr/claude-toolkit

    # Space-separated plugins to install (plugin@marketplace format) - optional
    # plugins: toolkit@claude-toolkit

    # Path to a Claude Code settings JSON to merge in - optional
    # claude_code_config: .claude/settings.json

    # Max agent turns per test - optional, default: 3
    # max_turns: 3

    # Per-test timeout in seconds - optional, default: 60
    # timeout: 60

    # Override model for all tests - optional
    # model: haiku
```

## Badge

Add a shields.io badge to your README:

```markdown
[![Skill Tests](https://img.shields.io/github/actions/workflow/status/<owner>/<repo>/skill-tests.yaml?label=skill%20tests)](https://github.com/<owner>/<repo>/actions/workflows/skill-tests.yaml)
```

## Test Fields

All fields available in a `skill-tests.yaml` manifest:

```yaml
# At least one of 'skill' or 'agent' is required
skill: toolkit:skill-development       # Skill to test (e.g. namespace:skill-name)
agent: exploration-protocol-orchestrator  # Agent to test (subagent_type value)
model: haiku                           # Model to use - optional, default: sonnet

tests:
  - id: my-test                        # Required: unique test identifier
    prompt: "I want to create a skill" # Required: prompt to send to Claude Code
    should_trigger: true               # Required: whether the skill/agent should be invoked
    expected_tools:                    # Optional: tools that must be called
      - Task
    notes: "User explicitly asks"      # Optional: human-readable explanation
```
