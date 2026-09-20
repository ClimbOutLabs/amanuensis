# Live tool-card folding

The model producer emits an empty `model.message`, then adds tool calls through
`model.message.delta`. The assistant-ui runtime must index invocation identities
after merging each delta as well as when receiving complete messages. Otherwise
the live result cannot find its card, even though reloading persisted history
reconstructs it correctly.

The runtime patch owns this index. Results remain scoped to their source model
event and raw tool-call ID; this fix does not add an unscoped fallback, change
PermissionGate admission, or execute an approval twice. The UI regression crosses
the snake-case SSE SDK adapter and the runtime fold, including an approval
continuation with no history reload.

Both patched source and generated JavaScript/source maps are committed through
the existing pnpm patch. Public declarations and wire schemas are unchanged.
Browser acceptance still checks real live cards, because persisted-history tests
alone did not expose this producer/consumer mismatch.
