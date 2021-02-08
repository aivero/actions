import * as core from "@actions/core";
import * as github from "@actions/github";
import { inspect } from "util";

async function run(): Promise<void> {
  const inputs = {
    token: core.getInput("token"),
    repository: core.getInput("repository"),
    commit: core.getInput("commit"),
    component: core.getInput("component"),
    state: core.getInput("state"),
  }
  core.startGroup(`Inputs`);
  core.info(`Inputs: ${inspect(inputs)}`);
  core.endGroup()

  const [owner, repo] = inputs.repository.split("/");
  const sha = inputs.commit;
  const context = inputs.component;
  const state = inputs.state as "error" | "success" | "failure" | "pending";
  const status = {
    owner,
    repo,
    sha,
    state,
    context,
  }
  const octokit = github.getOctokit(inputs.token);
  await octokit.repos.createCommitStatus(status);
}

run();
