// Verifies the SDK actually sends the Authorization header on the wire.
// Halt-worthy gap #2: all 31 wire tests used a mock server that never checked
// for the Authorization header, so a regression dropping auth would pass.

import { TrueForge } from "../../src/Client";
import { mockServerPool } from "../mock-server/MockServerPool";

describe("Authorization header", () => {
    test("client sends Bearer token on authenticated requests", async () => {
        const server = mockServerPool.createServer();
        const client = new TrueForge({ maxRetries: 0, token: "test-token-123", baseUrl: server.baseUrl });

        server
            .mockEndpoint()
            .get("/api/v1/auth/me")
            .headers({ Authorization: "Bearer test-token-123" })
            .respondWith()
            .statusCode(200)
            .jsonBody({
                data: {
                    roles: [],
                    subject: { display_name: "test", id: "id", type: "user" },
                    tenant_id: "tenant",
                    type: "default",
                },
            })
            .build();

        // If the client drops the Authorization header, the mock won't match
        // and this will throw (no handler matched the request).
        const response = await client.auth.me();
        expect(response.data.type).toBe("default");
    });
});
