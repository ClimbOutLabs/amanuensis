# Spec: LiteLLM Privacy Router

## Problem
Some queries need cloud model capabilities that local models cannot match. Today there is no controlled path to use them: either everything stays local (capability ceiling) or the user manually switches providers (no privacy guardrails).

## Solution
A LiteLLM-based routing layer that classifies each query by privacy sensitivity and routes accordingly. Sensitive queries stay on the local model. Non-sensitive queries can use cloud models. The user sees which lane each response took.

## Design Decisions

**Privacy classification before routing.** Every query is classified as sensitive or non-sensitive before any routing decision. Sensitive means: personal data, private documents, credentials, health info, financial details. Classification runs locally, never leaves the device.

**Two lanes, explicit.** Local lane: the Spark model, default for everything sensitive. Cloud lane: configured providers (OpenAI, Anthropic, etc.), only for queries classified non-sensitive. The UI shows which lane served each response.

**User override.** The user can force local-only mode (all queries stay on device) or allow cloud routing per query. The default is privacy-first: when classification is uncertain, stay local.

**LiteLLM as the abstraction.** LiteLLM provides the unified interface across providers. Adding or removing a cloud provider is config, not code. API keys are stored in the existing credential store, never in the repo.

## Scope
- Local privacy classifier (sensitive vs non-sensitive)
- LiteLLM routing layer with local and cloud lanes
- Lane indicator in chat UI
- User override: force local, allow cloud per query
- Cloud provider config (keys via credential store)
- Audit log: which lane served which query (local only)

## Privacy
- Classification runs on device
- Sensitive queries never leave the device, even if cloud is configured
- Cloud lane only receives queries classified non-sensitive
- API keys in credential store, masked in UI
- Audit log stays local

## Testing
- Synthetic queries only
- Verify: sensitive query (e.g. "what is my account number") stays local even with cloud configured
- Verify: non-sensitive query (e.g. "explain photosynthesis") can route to cloud
- Verify: uncertain classification defaults to local
- Verify: lane indicator is accurate
- Verify: force-local mode blocks all cloud calls (network-level test)

## Out of Scope
- Fine-tuning the classifier (rule-based + local model for v1)
- Automatic provider selection within cloud lane (user picks one)
- Cost tracking per provider (future)
- Streaming from multiple providers simultaneously
