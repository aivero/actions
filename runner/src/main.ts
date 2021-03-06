import * as core from "@actions/core";
import { inspect } from "util";
import { spawn } from "child_process";
import * as coreCommand from "@actions/core/lib/command";

type resultEnv = {
  key: string;
};

async function exec(cmd: string, env = process.env) {
  core.startGroup(`Running command: '${cmd}'`);

  if (!cmd) {
    throw new Error(`Invalid command: '${cmd}'`);
  }
  const child = await spawn(cmd, {
    stdio: ["ignore", "pipe", "pipe"],
    env: env,
    cwd: env["CWD"],
    shell: true,
  });

  let error = ""
  child.stderr.on("data", (data) => {
    error = data.toString("utf8").trim();
    core.info(error);
  });

  for await (const chunk of child.stdout) {
    core.info(chunk.toString("utf8").trim());
  }
  core.endGroup();

  const exitCode = await new Promise((resolve, reject) => {
    child.on("close", resolve);
  });

  if (exitCode) {
    throw new Error(`Command '${cmd}' failed with code: ${exitCode}\nError Output:\n${error}`);
  }
}

interface Inputs {
  cmdsPre?: string[];
  cmds?: string[];
  cmdsPost?: string[];
  env: resultEnv;
}

async function runCmds(
  cmds: string[],
  inputEnv: { key: string }
): Promise<resultEnv> {
  // Overwrite environment variables
  let env = process.env;
  for (const [key, val] of Object.entries(inputEnv)) {
    env[key] = val;
  }

  // Run commands
  for (const cmd of cmds) {
    await exec(cmd, env);
  }

  // Return environment
  let resEnv = {} as resultEnv;
  for (const key in env) resEnv[key] = env[key];
  return resEnv;
}

async function run(): Promise<void> {
  let resEnv = {} as resultEnv;
  let inputs;
  try {
    inputs = {
      cmdsPre: JSON.parse(core.getInput("cmdsPre")),
      cmds: JSON.parse(core.getInput("cmds")),
      cmdsPost: JSON.parse(core.getInput("cmdsPost")),
      env: JSON.parse(core.getInput("env")),
    };
    core.startGroup(`Inputs`);
    core.info(`Inputs: ${inspect(inputs)}`);
    core.endGroup();

    coreCommand.issueCommand(
      "save-state",
      { name: "cmdsPost" },
      JSON.stringify(inputs.cmdsPost)
    );

    resEnv = await runCmds(inputs.cmdsPre as string[], inputs.env);
    resEnv = await runCmds(inputs.cmds as string[], resEnv);
  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
  if (inputs?.cmdsPost?.length) {
    coreCommand.issueCommand(
      "save-state",
      { name: "envPost" },
      JSON.stringify(resEnv)
    );
  }
}

async function post(): Promise<void> {
  try {
    const env = JSON.parse(process.env["STATE_envPost"] || "{}");
    await runCmds(JSON.parse(process.env["STATE_cmdsPost"] as string), env);
  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}

// Main
if (!process.env["STATE_cmdsPost"]) {
  run();
} // Post
else {
  post();
}
