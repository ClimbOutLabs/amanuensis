# Reference
## Internal
<details><summary><code>client.internal.<a href="/src/api/resources/internal/client/Client.ts">listPermissions</a>({ ...params }) -> TrueForge.ListPermissionsResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Return granted actions for each requested agent, schedule, or session id.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.internal.listPermissions({
    resourceIds: ["resource_ids"],
    resourceType: "agent"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.ListPermissionsRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `InternalClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Agents
<details><summary><code>client.agents.<a href="/src/api/resources/agents/client/Client.ts">list</a>({ ...params }) -> core.Page&lt;TrueForge.Agent, TrueForge.ListAgentsResponse&gt;</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

List configured agents for the tenant, ordered by name. Optional `agent_name` filters by substring.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.agents.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.ListAgentsRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `AgentsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.agents.<a href="/src/api/resources/agents/client/Client.ts">create</a>({ ...params }) -> TrueForge.GetAgentResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Creates an agent and allocates an immutable id. Fails if `name` is already taken. Name cannot be changed later.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.agents.create({
    description: "description",
    manifest: {
        model: {
            name: "name"
        }
    },
    name: "name"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.CreateAgentRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `AgentsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.agents.<a href="/src/api/resources/agents/client/Client.ts">get</a>(agent_id) -> TrueForge.GetAgentResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Fetch a configured agent by immutable id.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.agents.get("agent_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**agent_id:** `string` — Immutable agent identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `AgentsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.agents.<a href="/src/api/resources/agents/client/Client.ts">update</a>(agent_id, { ...params }) -> TrueForge.GetAgentResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Update an existing agent by immutable id.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.agents.update("agent_id", {
    manifest: {
        model: {
            name: "name"
        }
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**agent_id:** `string` — Immutable agent identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.UpdateAgentRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `AgentsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.agents.<a href="/src/api/resources/agents/client/Client.ts">delete</a>(agent_id) -> TrueForge.DeleteAgentResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Delete a configured agent by immutable id.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.agents.delete("agent_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**agent_id:** `string` — Immutable agent identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `AgentsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Auth
<details><summary><code>client.auth.<a href="/src/api/resources/auth/client/Client.ts">me</a>() -> TrueForge.GetMeResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Returns the authenticated caller identity (`type`, `tenant_id`, `subject`, `roles`) wrapped as `{ data }`. `type` is `oidc-connected` when browser OIDC is enabled, otherwise `default`. When auth is enabled this requires a valid `id_token` cookie or `Authorization: Bearer` token (401 otherwise). When auth is disabled, returns the standalone default identity.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.auth.me();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `AuthClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Server
<details><summary><code>client.server.<a href="/src/api/resources/server/client/Client.ts">getCapabilities</a>() -> TrueForge.GetCapabilitiesResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Report optional runtime capabilities available for this tenant, and the identity of the running build.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.server.getCapabilities();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `ServerClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## MCP Servers
<details><summary><code>client.mcpServers.<a href="/src/api/resources/mcpServers/client/Client.ts">list</a>() -> TrueForge.ListAvailableMcpServersResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Configured MCP servers as a slim name/url list for the composer.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.mcpServers.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `McpServersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.mcpServers.<a href="/src/api/resources/mcpServers/client/Client.ts">get</a>(name) -> TrueForge.GetAvailableMcpServerResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

A single MCP server as the slim chat projection, with live per-user auth_status.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.mcpServers.get("name");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**name:** `string` — MCP server name.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `McpServersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.mcpServers.<a href="/src/api/resources/mcpServers/client/Client.ts">authorize</a>(name, { ...params }) -> TrueForge.McpAuthStatus</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Returns current auth status. When OAuth is required, includes an authorization URL. Optional return_to is the post-consent landing path.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.mcpServers.authorize("name");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**name:** `string` — MCP server name.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.AuthorizeMcpServersRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `McpServersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.mcpServers.<a href="/src/api/resources/mcpServers/client/Client.ts">deleteAuthorization</a>(name) -> TrueForge.GetMcpServerResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Disconnects OAuth for the MCP server when applicable and returns the updated server with auth_status. No-op when the server does not use stored OAuth tokens.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.mcpServers.deleteAuthorization("name");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**name:** `string` — MCP server name.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `McpServersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.mcpServers.<a href="/src/api/resources/mcpServers/client/Client.ts">memoryCheck</a>(name) -> TrueForge.MemoryProviderCheckResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Runs one live recall against the Hindsight REST API behind this connector, the surface host-enforced memory actually calls. That is not the MCP endpoint `auth_status` reflects, and it may validate a different credential. Read-only: the connector is never modified, and a failed check is a 200 carrying the reason. The same check runs on every create or replace that sets `manifest.memory_provider: true`.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.mcpServers.memoryCheck("name");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**name:** `string` — MCP server name.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `McpServersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.mcpServers.<a href="/src/api/resources/mcpServers/client/Client.ts">listTools</a>(name) -> TrueForge.ListMcpServerToolsResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

All tools exposed by the given MCP server (non-paginated), as returned by the MCP `tools/list` call.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.mcpServers.listTools("name");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**name:** `string` — MCP server name.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `McpServersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Models
<details><summary><code>client.models.<a href="/src/api/resources/models/client/Client.ts">list</a>() -> TrueForge.ListAvailableModelsResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Configured models as a slim FQN list for the composer.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.models.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `ModelsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Personalization
<details><summary><code>client.personalization.<a href="/src/api/resources/personalization/client/Client.ts">getContext</a>() -> TrueForge.GetPersonalizationContextResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Returns the exact root-thread-only personalization text supplied to the model for the current profile.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.personalization.getContext();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `PersonalizationClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.personalization.<a href="/src/api/resources/personalization/client/Client.ts">getProfile</a>() -> TrueForge.GetPersonalizationProfileResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Returns the authenticated user’s locally stored assistant and user profile.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.personalization.getProfile();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `PersonalizationClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.personalization.<a href="/src/api/resources/personalization/client/Client.ts">createOrUpdateProfile</a>({ ...params }) -> TrueForge.GetPersonalizationProfileResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Replaces the authenticated user’s profile and advances its revision only when model-relevant content changes.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.personalization.createOrUpdateProfile({
    profile: {
        assistantIdentity: "A thoughtful local-first personal assistant.",
        assistantName: "Aman",
        learningEnabled: false,
        pinnedPreferences: ["Use short bullet points."],
        userProfile: "Prefers local-first tools and plain English.",
        voiceGuidance: "Warm, direct, and concise."
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.UpdatePersonalizationProfileRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `PersonalizationClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.personalization.<a href="/src/api/resources/personalization/client/Client.ts">deleteProfile</a>() -> TrueForge.DeletePersonalizationProfileResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Removes only the authenticated user’s profile. Conversation records remain unchanged.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.personalization.deleteProfile();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `PersonalizationClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Personas
<details><summary><code>client.personas.<a href="/src/api/resources/personas/client/Client.ts">list</a>() -> TrueForge.ListPersonasResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Returns the authenticated user’s configured personas, ordered by display name.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.personas.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `PersonasClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.personas.<a href="/src/api/resources/personas/client/Client.ts">create</a>({ ...params }) -> TrueForge.GetPersonaResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Creates a persona bound to a fully qualified model name. Names and aliases must be unique across the user’s personas, because an ambiguous invocation has no correct answer.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.personas.create({
    persona: {
        aliases: ["aliases"],
        displayName: "Zara",
        instructions: "instructions",
        modelName: "model_name"
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.CreatePersonaRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `PersonasClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.personas.<a href="/src/api/resources/personas/client/Client.ts">update</a>(persona_id, { ...params }) -> TrueForge.GetPersonaResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Replaces a persona’s identity, role, and model binding.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.personas.update("persona_id", {
    persona: {
        aliases: ["aliases"],
        displayName: "Zara",
        instructions: "instructions",
        modelName: "model_name"
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**persona_id:** `string` — Stable persona identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.UpdatePersonaRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `PersonasClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.personas.<a href="/src/api/resources/personas/client/Client.ts">delete</a>(persona_id) -> TrueForge.DeletePersonaResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Removes a persona. Recorded activations are kept, so a past turn can still say which persona and model were selected for it.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.personas.delete("persona_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**persona_id:** `string` — Stable persona identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `PersonasClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.personas.<a href="/src/api/resources/personas/client/Client.ts">getContext</a>(persona_id) -> TrueForge.GetPersonaContextResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Returns the exact root-thread-only persona text supplied to the model when this persona is active.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.personas.getContext("persona_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**persona_id:** `string` — Stable persona identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `PersonasClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Repositories
<details><summary><code>client.repositories.<a href="/src/api/resources/repositories/client/Client.ts">list</a>() -> TrueForge.ListRepositoriesResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.repositories.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `RepositoriesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.repositories.<a href="/src/api/resources/repositories/client/Client.ts">create</a>({ ...params }) -> TrueForge.GetRepositoryResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Registers repository identity only. It does not clone, execute, or bind a chat.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.repositories.create({
    repository: {
        cloneUrl: "clone_url",
        name: "name"
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.CreateRepositoryRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `RepositoriesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.repositories.<a href="/src/api/resources/repositories/client/Client.ts">get</a>(repository_id) -> TrueForge.GetRepositoryResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.repositories.get("repository_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**repository_id:** `string` — Stable repository identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `RepositoriesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## RepositoryCommandProposals
<details><summary><code>client.repositoryCommandProposals.<a href="/src/api/resources/repositoryCommandProposals/client/Client.ts">list</a>(repository_id) -> TrueForge.ListVerifyCommandProposalsResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.repositoryCommandProposals.list("repository_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**repository_id:** `string` — Stable repository identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `RepositoryCommandProposalsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.repositoryCommandProposals.<a href="/src/api/resources/repositoryCommandProposals/client/Client.ts">delete</a>(repository_id, proposal_id) -> TrueForge.DeleteVerifyCommandProposalResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.repositoryCommandProposals.delete("repository_id", "proposal_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**repository_id:** `string` — Stable repository identifier.

</dd>
</dl>

<dl>
<dd>

**proposal_id:** `string`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `RepositoryCommandProposalsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.repositoryCommandProposals.<a href="/src/api/resources/repositoryCommandProposals/client/Client.ts">confirm</a>(repository_id, proposal_id, { ...params }) -> TrueForge.GetVerifyCommandResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.repositoryCommandProposals.confirm("repository_id", "proposal_id", {
    commandId: "command_id",
    timeoutMs: 1
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**repository_id:** `string` — Stable repository identifier.

</dd>
</dl>

<dl>
<dd>

**proposal_id:** `string`

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.ConfirmVerifyCommandProposalRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `RepositoryCommandProposalsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## RepositoryCommands
<details><summary><code>client.repositoryCommands.<a href="/src/api/resources/repositoryCommands/client/Client.ts">list</a>(repository_id) -> TrueForge.ListVerifyCommandsResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Only these host-confirmed commands can be invoked through run_registered_command.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.repositoryCommands.list("repository_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**repository_id:** `string` — Stable repository identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `RepositoryCommandsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.repositoryCommands.<a href="/src/api/resources/repositoryCommands/client/Client.ts">createOrUpdate</a>(repository_id, command_id, { ...params }) -> TrueForge.GetVerifyCommandResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.repositoryCommands.createOrUpdate("repository_id", "command_id", {
    command: "command",
    purpose: "build",
    timeoutMs: 1
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**repository_id:** `string` — Stable repository identifier.

</dd>
</dl>

<dl>
<dd>

**command_id:** `string`

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.UpsertVerifyCommandRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `RepositoryCommandsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.repositoryCommands.<a href="/src/api/resources/repositoryCommands/client/Client.ts">delete</a>(repository_id, command_id, { ...params }) -> TrueForge.DeleteVerifyCommandResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.repositoryCommands.delete("repository_id", "command_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**repository_id:** `string` — Stable repository identifier.

</dd>
</dl>

<dl>
<dd>

**command_id:** `string`

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.DeleteRepositoryCommandsRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `RepositoryCommandsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Schedules
<details><summary><code>client.schedules.<a href="/src/api/resources/schedules/client/Client.ts">list</a>({ ...params }) -> core.Page&lt;TrueForge.Schedule, TrueForge.ListSchedulesResponse&gt;</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

List schedules for the tenant, newest first.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.schedules.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.ListSchedulesRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SchedulesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.schedules.<a href="/src/api/resources/schedules/client/Client.ts">create</a>({ ...params }) -> TrueForge.GetScheduleResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Create a schedule for an existing agent (by name) and add its first pending run when active.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.schedules.create({
    agentName: "agent_name",
    manifest: {
        cron: "cron",
        task: "task"
    },
    name: "name"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.CreateScheduleRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SchedulesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.schedules.<a href="/src/api/resources/schedules/client/Client.ts">createRun</a>({ ...params }) -> TrueForge.CreateScheduleRunResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Start a schedule run immediately using the schedule task. Does not replace or advance the cron pending run.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.schedules.createRun({
    scheduleId: "schedule_id"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.CreateScheduleRunRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SchedulesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.schedules.<a href="/src/api/resources/schedules/client/Client.ts">get</a>(schedule_id) -> TrueForge.GetScheduleResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Get a schedule by id.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.schedules.get("schedule_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**schedule_id:** `string` — Immutable schedule identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SchedulesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.schedules.<a href="/src/api/resources/schedules/client/Client.ts">update</a>(schedule_id, { ...params }) -> TrueForge.GetScheduleResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Replace name and manifest; replaces or drops the pending run when status/cron/timezone change.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.schedules.update("schedule_id", {
    manifest: {
        cron: "cron",
        task: "task"
    },
    name: "name"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**schedule_id:** `string` — Immutable schedule identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.UpdateScheduleRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SchedulesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.schedules.<a href="/src/api/resources/schedules/client/Client.ts">delete</a>(schedule_id) -> TrueForge.DeleteScheduleResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Delete a schedule and its runs. Idempotent.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.schedules.delete("schedule_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**schedule_id:** `string` — Immutable schedule identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SchedulesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.schedules.<a href="/src/api/resources/schedules/client/Client.ts">listRuns</a>(schedule_id, { ...params }) -> core.Page&lt;TrueForge.ScheduleRun, TrueForge.ListScheduleRunsResponse&gt;</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

List runs of a schedule, newest `scheduled_for` first. Available to its creator or a manager of its agent.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.schedules.listRuns("schedule_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**schedule_id:** `string` — Immutable schedule identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.ListRunsSchedulesRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SchedulesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## SessionFolders
<details><summary><code>client.sessionFolders.<a href="/src/api/resources/sessionFolders/client/Client.ts">list</a>() -> TrueForge.ListSessionFoldersResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessionFolders.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `SessionFoldersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessionFolders.<a href="/src/api/resources/sessionFolders/client/Client.ts">create</a>({ ...params }) -> TrueForge.GetSessionFolderResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessionFolders.create({
    name: "name"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.CreateSessionFolderRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionFoldersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessionFolders.<a href="/src/api/resources/sessionFolders/client/Client.ts">update</a>(folder_id, { ...params }) -> TrueForge.GetSessionFolderResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessionFolders.update("folder_id", {
    name: "name"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**folder_id:** `string` — Immutable session folder identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.UpdateSessionFolderRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionFoldersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessionFolders.<a href="/src/api/resources/sessionFolders/client/Client.ts">delete</a>(folder_id) -> TrueForge.DeleteSessionFolderResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Deletes the folder and leaves its sessions unassigned.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessionFolders.delete("folder_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**folder_id:** `string` — Immutable session folder identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionFoldersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Sessions
<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">list</a>({ ...params }) -> core.Page&lt;TrueForge.Session, TrueForge.ListSessionsResponse&gt;</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

List the sessions (newest first by default).
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.ListSessionsRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">create</a>({ ...params }) -> TrueForge.GetSessionResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Create a session with `agent` as either `{ name }` (named registry binding) or `{ spec: AgentSpec }` (inline). Named sessions snapshot the agent name at create and resolve the live agent on each turn. Responses use `{ type: "reference", name, id }` or `{ type: "inline", spec }`.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.create({
    agent: {
        name: "name"
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.CreateSessionRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">get</a>(session_id) -> TrueForge.GetSessionResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Fetch a session by ID. Only the session creator may fetch it.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.get("session_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">delete</a>(session_id) -> void</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Delete a session and all related turns, events, and internal state. Only the session creator may delete it. Idempotent if already gone.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.delete("session_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">update</a>(session_id, { ...params }) -> TrueForge.GetSessionResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Update a session by replacing `agent` with `{ spec: AgentSpec }`. Named (reference) sessions reject agent updates. An empty body is a valid no-op that refreshes `updated_at`. Only the session creator may update it.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.update("session_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.UpdateSessionRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">createBugReport</a>(session_id, { ...params }) -> TrueForge.CreateSessionBugReportResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Assembles a redacted diagnostic bundle for this session: build identity, a structural per-turn event trace (event types, tool names/effects/outcomes, durations, counts), recent errors, non-secret config flags, and the optional description supplied in the request body, included verbatim. Message text, memory-recall content, learned-profile text, tool-call arguments/results, and any credential or token value are never included — see the response `redaction` field — unless the request sets `include_chat`, which adds the user and assistant message text under `chat` at the reporter's request. Only the session creator (`created_by`) may generate it.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.createBugReport("session_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.CreateSessionBugReportRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">cancel</a>(session_id, { ...params }) -> TrueForge.CancelSessionResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Cancel the running last turn for a session. Only the session creator may cancel.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.cancel("session_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.CancelSessionRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">listEvents</a>(session_id, { ...params }) -> core.Page&lt;TrueForge.SessionEventItem, TrueForge.ListSessionEventsResponse&gt;</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

List session events as `{ turn_id, event }` across the active turn branch (newest first), including persisted events from a running tip. Each turn contributes turn.created, content events (model.message, tool.call, …), and turn.done when terminal; streaming deltas are not included. Use `page_token` to paginate backward toward older events while retaining the original branch anchor. Only the session creator may list events.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.listEvents("session_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.ListEventsSessionsRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">setFolder</a>(session_id, { ...params }) -> TrueForge.SetSessionFolderResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.setFolder("session_id", {
    folderId: "folder_id"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.SetSessionFolderRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">clearFolder</a>(session_id) -> TrueForge.SetSessionFolderResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.clearFolder("session_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">listImplementationPlanGrants</a>(session_id) -> TrueForge.ListImplementationPlanGrantsResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

List active durable implementation-plan grants for this session and its current repository binding, including between turns. Only the session creator may list them.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.listImplementationPlanGrants("session_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">revokeImplementationPlanGrant</a>(session_id, grant_id) -> TrueForge.RevokeImplementationPlanGrantResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Durably revoke one implementation-plan grant for the session, including between turns. A conflict response means an already-admitted dispatch remains pending. Only the session creator may revoke it.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.revokeImplementationPlanGrant("session_id", "grant_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**grant_id:** `string` — Integrity-derived implementation-plan grant identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">listTurns</a>(session_id, { ...params }) -> core.Page&lt;TrueForge.Turn, TrueForge.ListTurnsResponse&gt;</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

List turns for a session (newest first by default), token-paginated. Only the session creator may list turns.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.listTurns("session_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.ListTurnsSessionsRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">createTurnStream</a>(session_id, { ...params }) -> core.Stream&lt;TrueForge.TurnStreamingEvent&gt;</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Create a turn within a session and execute it.
Only the session creator may create turns.
When `stream` is true (default), respond with a Server-Sent Events stream of turn events.
When `stream` is false, return the turn immediately with `state.status: "running"` while execution continues in the background; use get turn or subscribe to observe completion.
Use `previous_turn_id` to chain to the session's last turn (defaults to `auto`); use `none` for a new root.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
const response = await client.sessions.createTurnStream("session_id", {});
for await (const item of response) {
    console.log(item);
}

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.CreateTurnSessionsStreamRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">createTurn</a>(session_id, { ...params }) -> TrueForge.GetTurnResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Create a turn within a session and execute it.
Only the session creator may create turns.
When `stream` is true (default), respond with a Server-Sent Events stream of turn events.
When `stream` is false, return the turn immediately with `state.status: "running"` while execution continues in the background; use get turn or subscribe to observe completion.
Use `previous_turn_id` to chain to the session's last turn (defaults to `auto`); use `none` for a new root.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.createTurn("session_id", {});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.CreateTurnSessionsRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">getTurn</a>(session_id, turn_id) -> TrueForge.GetTurnResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Fetch a single turn by ID. Only the session creator may fetch it.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.getTurn("session_id", "turn_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**turn_id:** `string` — Turn identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">downloadSandboxFile</a>(session_id, turn_id, { ...params }) -> core.BinaryResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Download a file from the sandbox this turn ran in. Paths come from the assistant's `sandbox_artifacts` block. Only the session creator may download.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.downloadSandboxFile("session_id", "turn_id", {
    path: "x"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**turn_id:** `string` — Turn identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.DownloadSandboxFileSessionsRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">listTurnEvents</a>(session_id, turn_id, { ...params }) -> core.Page&lt;TrueForge.SessionEvent, TrueForge.ListTurnEventsResponse&gt;</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Paginated persisted events for a turn (insertion order by default). Only the session creator may list events.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessions.listTurnEvents("session_id", "turn_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**turn_id:** `string` — Turn identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.ListTurnEventsSessionsRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessions.<a href="/src/api/resources/sessions/client/Client.ts">subscribeToTurn</a>(session_id, turn_id, { ...params }) -> core.Stream&lt;TrueForge.TurnStreamingEvent&gt;</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Subscribe to the live SSE stream for a turn. Only the session creator may subscribe. Pass `after_sequence_number` to resume after a disconnect (exclusive — events after this sequence number are replayed).
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
const response = await client.sessions.subscribeToTurn("session_id", "turn_id");
for await (const item of response) {
    console.log(item);
}

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**turn_id:** `string` — Turn identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.SubscribeToTurnSessionsRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## SessionPersonas
<details><summary><code>client.sessionPersonas.<a href="/src/api/resources/sessionPersonas/client/Client.ts">get</a>(session_id) -> TrueForge.GetSessionPersonaResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Returns the most recent persona decision for this chat, or null when it never left the default assistant.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessionPersonas.get("session_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionPersonasClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessionPersonas.<a href="/src/api/resources/sessionPersonas/client/Client.ts">createOrUpdate</a>(session_id, { ...params }) -> TrueForge.GetSessionPersonaResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Records an explicit persona decision for this chat. `persona_id: null` returns to the default assistant. The chat’s own model setting is never changed.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessionPersonas.createOrUpdate("session_id", {
    personaId: "persona-id"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.SetSessionPersonaRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionPersonasClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessionPersonas.<a href="/src/api/resources/sessionPersonas/client/Client.ts">listActivations</a>(session_id) -> TrueForge.ListPersonaActivationsResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Newest-first log of which persona was selected for this chat and why. Entries carrying a `turn_id` are that turn’s selection provenance.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessionPersonas.listActivations("session_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionPersonasClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## SessionRepository
<details><summary><code>client.sessionRepository.<a href="/src/api/resources/sessionRepository/client/Client.ts">get</a>(session_id) -> TrueForge.GetSessionRepositoryBindingResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessionRepository.get("session_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionRepositoryClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessionRepository.<a href="/src/api/resources/sessionRepository/client/Client.ts">createOrUpdate</a>(session_id, { ...params }) -> TrueForge.GetSessionRepositoryBindingResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessionRepository.createOrUpdate("session_id", {
    repositoryId: "repository_id",
    workspaceCwd: "workspace_cwd"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.BindSessionRepositoryRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionRepositoryClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.sessionRepository.<a href="/src/api/resources/sessionRepository/client/Client.ts">delete</a>(session_id, { ...params }) -> TrueForge.DeleteSessionRepositoryBindingResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.sessionRepository.delete("session_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**session_id:** `string` — Session identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.DeleteSessionRepositoryRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionRepositoryClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Skills
<details><summary><code>client.skills.<a href="/src/api/resources/skills/client/Client.ts">list</a>() -> TrueForge.ListAvailableSkillsResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Configured skills as a slim name/description list for the composer.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.skills.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `SkillsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.skills.<a href="/src/api/resources/skills/client/Client.ts">listVersions</a>({ ...params }) -> TrueForge.ListSkillVersionsResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Versions for one skill.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.skills.listVersions({
    name: "name"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.ListVersionsSkillsRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SkillsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Spaces
<details><summary><code>client.spaces.<a href="/src/api/resources/spaces/client/Client.ts">list</a>({ ...params }) -> TrueForge.ListSpacesResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Returns the authenticated user’s spaces, ordered by name.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.spaces.list({
    limit: 500,
    offset: 0
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.ListSpacesRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SpacesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.spaces.<a href="/src/api/resources/spaces/client/Client.ts">create</a>({ ...params }) -> TrueForge.CreateSpaceResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.spaces.create({
    expectedAggregateRevision: 0,
    space: {
        body: "body",
        name: "name",
        purpose: "purpose",
        status: "active"
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.CreateSpaceRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SpacesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.spaces.<a href="/src/api/resources/spaces/client/Client.ts">get</a>(space_id) -> TrueForge.GetSpaceResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.spaces.get("space_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**space_id:** `string`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SpacesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.spaces.<a href="/src/api/resources/spaces/client/Client.ts">update</a>(space_id, { ...params }) -> TrueForge.UpdateSpaceResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.spaces.update("space_id", {
    expectedAggregateRevision: 0,
    expectedRevision: 0,
    space: {
        body: "body",
        name: "name",
        purpose: "purpose",
        status: "active"
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**space_id:** `string`

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.UpdateSpaceRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SpacesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.spaces.<a href="/src/api/resources/spaces/client/Client.ts">delete</a>(space_id, { ...params }) -> void</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Deletes a space. No tool exposes this to the model; only a person acting through the UI can delete a space.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.spaces.delete("space_id", {
    expectedRevision: 1
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**space_id:** `string`

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.DeleteSpacesRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SpacesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Catalogs McpServers
<details><summary><code>client.catalogs.mcpServers.<a href="/src/api/resources/catalogs/resources/mcpServers/client/Client.ts">list</a>() -> TrueForge.GetMcpServerCatalogResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Shipped MCP server presets (discovery-only). Copy into PUT /settings/mcp-servers to configure.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.catalogs.mcpServers.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `McpServersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Catalogs ModelProviders
<details><summary><code>client.catalogs.modelProviders.<a href="/src/api/resources/catalogs/resources/modelProviders/client/Client.ts">list</a>() -> TrueForge.GetModelProviderCatalogResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Shipped model-provider presets (discovery-only). Copy into PUT /settings/model-providers to configure. Includes a `custom` sentinel with `supported_reasoning_efforts`.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.catalogs.modelProviders.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `ModelProvidersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Catalogs SandboxProviders
<details><summary><code>client.catalogs.sandboxProviders.<a href="/src/api/resources/catalogs/resources/sandboxProviders/client/Client.ts">list</a>() -> TrueForge.GetSandboxProviderCatalogResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Shipped sandbox-provider presets (discovery-only). Copy into PUT /settings/sandbox-providers to configure.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.catalogs.sandboxProviders.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `SandboxProvidersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Catalogs Skills
<details><summary><code>client.catalogs.skills.<a href="/src/api/resources/catalogs/resources/skills/client/Client.ts">list</a>() -> TrueForge.GetSkillCatalogResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Shipped skill presets (discovery-only). Copy into PUT /settings/skills to configure.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.catalogs.skills.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `SkillsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Internal Metrics
<details><summary><code>client.internal.metrics.<a href="/src/api/resources/internal/resources/metrics/client/Client.ts">listCharts</a>() -> TrueForge.GetSessionMetricsChartResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

List available session metric charts.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.internal.metrics.listCharts();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `MetricsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.internal.metrics.<a href="/src/api/resources/internal/resources/metrics/client/Client.ts">getChartData</a>({ ...params }) -> TrueForge.GetSessionMetricsChartDataResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Return one chart for the caller's sessions on a named agent over an inclusive creation-time window. Uses hourly buckets for windows up to 24 hours and daily UTC buckets otherwise.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.internal.metrics.getChartData({
    agentId: "agent_id",
    startTimestamp: new Date("2024-01-15T09:30:00.000Z"),
    endTimestamp: new Date("2024-01-15T09:30:00.000Z"),
    chartName: "sessions_over_time"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.internal.GetChartDataMetricsRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `MetricsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.internal.metrics.<a href="/src/api/resources/internal/resources/metrics/client/Client.ts">getMeters</a>({ ...params }) -> TrueForge.GetSessionMetricsMeterResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Aggregate the caller's session meters for a named agent over an inclusive creation-time window.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.internal.metrics.getMeters({
    agentId: "agent_id",
    startTimestamp: new Date("2024-01-15T09:30:00.000Z"),
    endTimestamp: new Date("2024-01-15T09:30:00.000Z")
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.internal.GetMetersMetricsRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `MetricsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Internal Schedules
<details><summary><code>client.internal.schedules.<a href="/src/api/resources/internal/resources/schedules/client/Client.ts">executeRun</a>({ ...params }) -> void</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Execute a persisted schedule run using its saved schedule and agent.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.internal.schedules.executeRun({
    scheduleRunId: "schedule_run_id"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.internal.ExecuteScheduleRunRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SchedulesClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Internal Sessions
<details><summary><code>client.internal.sessions.<a href="/src/api/resources/internal/resources/sessions/client/Client.ts">getOrCreateByExternalId</a>({ ...params }) -> TrueForge.GetSessionResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Idempotent get-or-create: returns the existing session for this `external_id`, or creates one
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.internal.sessions.getOrCreateByExternalId({
    agent: {
        name: "name"
    },
    externalId: "external_id"
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.internal.GetOrCreateSessionByExternalIdRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SessionsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Internal Agents
<details><summary><code>client.internal.agents.<a href="/src/api/resources/internal/resources/agents/client/Client.ts">getCodeSnippets</a>(agent_id, { ...params }) -> TrueForge.GetAgentCodeSnippetsResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

TypeScript TrueForge SDK samples (stream and non-stream) for creating a session and turn against this agent.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.internal.agents.getCodeSnippets("agent_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**agent_id:** `string` — Immutable agent identifier.

</dd>
</dl>

<dl>
<dd>

**request:** `TrueForge.internal.GetCodeSnippetsAgentsRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `AgentsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Settings McpServers
<details><summary><code>client.settings.mcpServers.<a href="/src/api/resources/settings/resources/mcpServers/client/Client.ts">list</a>() -> TrueForge.ListMcpServersResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Configured MCP servers with auth_status. Header secrets are redacted.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.mcpServers.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `McpServersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.settings.mcpServers.<a href="/src/api/resources/settings/resources/mcpServers/client/Client.ts">create</a>({ ...params }) -> TrueForge.GetMcpServerResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Creates an MCP server by `name`. Fails if `name` is already taken. Runs DCR registration when `auth.type` is `dcr`. Header secrets: real value required; redacted with no stored value returns 400.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.mcpServers.create({
    manifest: {
        description: "description",
        name: "name",
        type: "remote",
        url: "url"
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.settings.CreateMcpServerRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `McpServersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.settings.mcpServers.<a href="/src/api/resources/settings/resources/mcpServers/client/Client.ts">createOrUpdate</a>({ ...params }) -> TrueForge.GetMcpServerResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Create or replace by `name`. Header secrets: real value sets/rotates; redacted keeps existing (400 if none).
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.mcpServers.createOrUpdate({
    manifest: {
        description: "description",
        name: "name",
        type: "remote",
        url: "url"
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.settings.UpdateMcpServerRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `McpServersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.settings.mcpServers.<a href="/src/api/resources/settings/resources/mcpServers/client/Client.ts">get</a>(name) -> TrueForge.GetMcpServerResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

A single MCP server by name, with nested live auth_status (settings / admin projection). Header auth values are redacted.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.mcpServers.get("name");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**name:** `string` — MCP server name.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `McpServersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.settings.mcpServers.<a href="/src/api/resources/settings/resources/mcpServers/client/Client.ts">delete</a>(name) -> TrueForge.DeleteMcpServerResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Deletes an MCP server by `name`, clearing any stored OAuth authorization for it first. A session whose agent spec still names this server hits the existing unregistered-server error on next use.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.mcpServers.delete("name");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**name:** `string` — MCP server name.

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `McpServersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Settings ModelProviders
<details><summary><code>client.settings.modelProviders.<a href="/src/api/resources/settings/resources/modelProviders/client/Client.ts">list</a>() -> TrueForge.ListModelProvidersResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

All configured providers with nested manifests.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.modelProviders.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `ModelProvidersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.settings.modelProviders.<a href="/src/api/resources/settings/resources/modelProviders/client/Client.ts">create</a>({ ...params }) -> TrueForge.GetModelProviderResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Creates a provider (models included). Fails if `name` is already taken. Well-known types use `type` as `name` (one each); `custom` is named by the caller. `auth.api_key`: real value required; redacted with no stored secret returns 400.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.modelProviders.create({
    manifest: {
        auth: {
            apiKey: "api_key"
        },
        models: [{
                modelId: "model_id",
                name: "name",
                properties: {}
            }],
        type: "alibaba"
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.settings.CreateModelProviderRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `ModelProvidersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.settings.modelProviders.<a href="/src/api/resources/settings/resources/modelProviders/client/Client.ts">createOrUpdate</a>({ ...params }) -> TrueForge.GetModelProviderResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Create or replace a provider (models included). Well-known types use `type` as `name` (one each); `custom` is named by the caller. `auth.api_key`: real value sets/rotates; redacted keeps existing (400 if none).
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.modelProviders.createOrUpdate({
    manifest: {
        auth: {
            apiKey: "api_key"
        },
        models: [{
                modelId: "model_id",
                name: "name",
                properties: {}
            }],
        type: "alibaba"
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.settings.UpdateModelProviderRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `ModelProvidersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.settings.modelProviders.<a href="/src/api/resources/settings/resources/modelProviders/client/Client.ts">delete</a>(name) -> TrueForge.DeleteModelProviderResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.modelProviders.delete("name");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**name:** `TrueForge.ResourceName`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `ModelProvidersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Settings SandboxProviders
<details><summary><code>client.settings.sandboxProviders.<a href="/src/api/resources/settings/resources/sandboxProviders/client/Client.ts">get</a>() -> TrueForge.GetSandboxProviderResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

The single configured sandbox provider for this tenant. `auth.api_key` is redacted.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.sandboxProviders.get();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `SandboxProvidersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.settings.sandboxProviders.<a href="/src/api/resources/settings/resources/sandboxProviders/client/Client.ts">createOrUpdate</a>({ ...params }) -> TrueForge.GetSandboxProviderResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Upserts the single sandbox provider for this tenant: creates it or replaces its entire configuration. `auth.api_key`: real value sets/rotates; redacted keeps existing (400 if none).
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.sandboxProviders.createOrUpdate({
    manifest: {
        auth: {
            apiKey: "api_key"
        },
        autoArchiveIntervalInMinutes: 1,
        autoDeleteIntervalInMinutes: 1,
        autoStopIntervalInMinutes: 1,
        execTimeoutMs: 1,
        type: "daytona"
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.settings.UpdateSandboxProviderRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SandboxProvidersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.settings.sandboxProviders.<a href="/src/api/resources/settings/resources/sandboxProviders/client/Client.ts">upgradeImage</a>(provider_id) -> TrueForge.GetSandboxProviderResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Explicitly registers the release-owned sandbox image for future sandboxes. Existing running sandboxes and snapshots are unchanged.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.sandboxProviders.upgradeImage("provider_id");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**provider_id:** `string` — Configured sandbox-provider id (currently the provider type).

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SandboxProvidersClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

## Settings Skills
<details><summary><code>client.settings.skills.<a href="/src/api/resources/settings/resources/skills/client/Client.ts">list</a>() -> TrueForge.ListSkillsResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

All configured skills with nested manifests (settings / admin projection).
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.skills.list();

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**requestOptions:** `SkillsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.settings.skills.<a href="/src/api/resources/settings/resources/skills/client/Client.ts">create</a>({ ...params }) -> TrueForge.GetSkillResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Creates a skill keyed by `name`. Fails if `name` is already taken.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.skills.create({
    manifest: {
        description: "description",
        name: "name",
        ref: "ref",
        type: "git",
        url: "url"
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.settings.CreateSkillRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SkillsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.settings.skills.<a href="/src/api/resources/settings/resources/skills/client/Client.ts">createOrUpdate</a>({ ...params }) -> TrueForge.GetSkillResponse</code></summary>
<dl>
<dd>

#### 📝 Description

<dl>
<dd>

<dl>
<dd>

Full upsert keyed by `name`: creates the skill or replaces its entire manifest.
</dd>
</dl>
</dd>
</dl>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.skills.createOrUpdate({
    manifest: {
        description: "description",
        name: "name",
        ref: "ref",
        type: "git",
        url: "url"
    }
});

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**request:** `TrueForge.settings.UpdateSkillRequest`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SkillsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

<details><summary><code>client.settings.skills.<a href="/src/api/resources/settings/resources/skills/client/Client.ts">delete</a>(name) -> TrueForge.DeleteSkillResponse</code></summary>
<dl>
<dd>

#### 🔌 Usage

<dl>
<dd>

<dl>
<dd>

```typescript
await client.settings.skills.delete("name");

```
</dd>
</dl>
</dd>
</dl>

#### ⚙️ Parameters

<dl>
<dd>

<dl>
<dd>

**name:** `TrueForge.ResourceName`

</dd>
</dl>

<dl>
<dd>

**requestOptions:** `SkillsClient.RequestOptions`

</dd>
</dl>
</dd>
</dl>


</dd>
</dl>
</details>

