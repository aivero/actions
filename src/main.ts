import * as core from "@actions/core";
import * as github from "@actions/github";
import { inspect } from "util";

async function run(): Promise<void> {
  const inputs = {
    token: core.getInput("token"),
    repository: core.getInput("repository"),
    commit: core.getInput("commit"),
    context: core.getInput("context"),
    status: core.getInput("status"),
  }
  core.startGroup(`Inputs`);
  core.info(`Inputs: ${inspect(inputs)}`);
  core.endGroup()

  const [owner, repo] = inputs.repository.split("/");
  const sha = inputs.commit;
  const context = inputs.context;
  const status = inputs.status as "error" | "success" | "cancelled";
  let state = "failure" as "failure" | "success";
  if (status == "success") {
    state = "success";
  };
  const statusEvent = {
    owner,
    repo,
    sha,
    state,
    context,
  }
  const octokit = github.getOctokit(inputs.token);
  await octokit.repos.createCommitStatus(statusEvent);
}

run();
