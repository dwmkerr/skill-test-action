# skill-test-action

GitHub Action to test Claude Code skill routing with declarative YAML manifests.

## Usage

```yaml
- uses: dwmkerr/skill-test-action@main
  with:
    test_file: tests/skill-tests.yaml
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    marketplaces: dwmkerr/claude-toolkit
    plugins: toolkit@claude-toolkit
```

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

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `test_file` | yes | | Path to YAML test file (or glob) |
| `anthropic_api_key` | yes | | Anthropic API key |
| `marketplaces` | no | | Space-separated marketplace repos to add |
| `plugins` | no | | Space-separated plugins to install |
| `claude_code_config` | no | | Path to Claude Code settings JSON |
| `max_turns` | no | `3` | Max agent turns per test |
| `timeout` | no | `60` | Per-test timeout in seconds |
| `model` | no | | Override model for all tests |

## Badge

Add a shields.io badge to your README:

```markdown
[![Skill Tests](https://img.shields.io/github/actions/workflow/status/<owner>/<repo>/skill-tests.yaml?label=skill%20tests)](https://github.com/<owner>/<repo>/actions/workflows/skill-tests.yaml)
```

## Test Fields

| Field | Required | Description |
|-------|----------|-------------|
| `skill` | no* | Skill to test (e.g. `toolkit:skill-development`) |
| `agent` | no* | Agent to test (e.g. `exploration-protocol-orchestrator`) |
| `model` | no | Model to use (default: `sonnet`) |
| `tests[].id` | yes | Unique test identifier |
| `tests[].prompt` | yes | Prompt to send to Claude Code |
| `tests[].should_trigger` | yes | Whether the skill/agent should be invoked |
| `tests[].expected_tools` | no | Tools that should be called |
| `tests[].notes` | no | Human-readable explanation |

*At least one of `skill` or `agent` should be specified.
