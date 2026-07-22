import { describe, expect, it } from "vitest";
import { loadServiceConfig } from "./config.js";

const BASE_ENVIRONMENT = {
  CREDENTIALS_DIRECTORY: "/nonexistent",
  BROKER_COMPANY_ID: "11111111-1111-4111-8111-111111111111",
  BROKER_RELEASE_BOT_AGENT_ID: "22222222-2222-4222-8222-222222222222",
  BROKER_GITLAB_PROJECT_ID: "92",
  BROKER_MAIN_LOCK_ISSUE: "GOT-66",
  BROKER_PAPERCLIP_API_URL: "https://paperclip.example.test",
  BROKER_GITLAB_API_URL: "https://gitlab.tidycode.it",
  BROKER_ALLOWED_CLIENT_FINGERPRINTS: `sha256:${"a".repeat(64)}`,
  BROKER_GATE_GENERATION: "1",
};

describe("release broker service configuration", () => {
  it.each(["GITLAB_API_TOKEN", "GITLAB_TOKEN", "PAPERCLIP_API_KEY"])(
    "rejects %s from the process environment",
    async (name) => {
      await expect(loadServiceConfig({ ...BASE_ENVIRONMENT, [name]: "forbidden" }))
        .rejects.toThrow(`${name} must be supplied through systemd credentials`);
    },
  );

  it("pins the GitLab project, origin and main-lock issue", async () => {
    await expect(loadServiceConfig({ ...BASE_ENVIRONMENT, BROKER_GITLAB_PROJECT_ID: "93" }))
      .rejects.toThrow("Invalid BROKER_GITLAB_PROJECT_ID");
    await expect(loadServiceConfig({ ...BASE_ENVIRONMENT, BROKER_GITLAB_API_URL: "https://gitlab.example.test" }))
      .rejects.toThrow("Invalid BROKER_GITLAB_API_URL");
    await expect(loadServiceConfig({ ...BASE_ENVIRONMENT, BROKER_MAIN_LOCK_ISSUE: "GOT-999" }))
      .rejects.toThrow("Invalid BROKER_MAIN_LOCK_ISSUE");
  });
});
