# @truefoundry/trueforge-chat

The non-visual chat client machinery shared by the TrueForge web UI and the Aman terminal app.

This package holds the parts of a chat client that never render anything:

- `createTrueForgeClient` builds the generated SDK client for a server address, with the host owning sign-in.
- `createSessionResyncExtensions` reads the session's newest turn, answers actions a scheduled run held for the owner, dismisses approvals still pending, and reports the latest context compaction and context size. The blocked-send signal in the same module lets a failed send tell the approvals banner to offer the dismiss action at once.
- `createPrivateChatExtensions` reads where a chat's words go, for the private chat banner.

It depends only on the generated SDK, `@truefoundry/trueforge-sdk`. It imports no React and no UI code, so a terminal client can use it as it stands.

## License

[MPL-2.0](https://github.com/ClimbOutLabs/amanuensis/blob/main/LICENSE). Portions derived from TrueForge are MIT licensed. See [NOTICE](https://github.com/ClimbOutLabs/amanuensis/blob/main/NOTICE).
