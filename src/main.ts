import * as core from "@actions/core";
import { inspect } from "util";
import { spawn } from "child_process";
import * as coreCommand from "@actions/core/lib/command";
import { env } from "process";

async function exec(
  full_cmd: string,
  env = process.env,
) {
  core.startGroup(`Running command: '${full_cmd}'`);
  // Replace env vars in command
  full_cmd = full_cmd.replace(/\$[a-zA-Z0-9_]*/g, match => {
    const env_var = match.substring(1);
    return env[env_var] || "undefined";
  });

  // Handle assignment 
  let match = full_cmd.match(/([a-zA-Z0-9_]*)=(.*)/)
  if (match) {
    env[match[1]] = match[2];
    core.endGroup();
    return;
  }

  // Handle change directory
  match = full_cmd.match(/cd (.*)/)
  if (match) {
    env["CWD"] = match[1]; 
    core.endGroup();
    return;
  }

  let args = full_cmd.split(" ");
  let cmd = args.shift();
  if (!cmd) {
    throw new Error(`Invalid command: '${full_cmd}'`);
  }
  const child = await spawn(
    cmd,
    args,
    { stdio: ["ignore", "pipe", "pipe"], env: env, cwd: env["CWD"] },
  );

  child.stderr.on("data", (data) => {
    core.error(data.toString("utf8"));
  });

  let res = "";
  for await (const chunk of child.stdout) {
    core.info(chunk);
  }
  core.endGroup();

  const exit_code = await new Promise((resolve, reject) => {
    child.on("close", resolve);
  });

  if (exit_code) {
    throw new Error(`Command '${full_cmd}' failed with code: ${exit_code}`);
  }
}

interface Inputs {
  cmds?: string[],
  cmdsPost?: string[],
  env: {key: string};
}

async function runCmds(cmds: string[], env = process.env) {
  try {
    for (const cmd of cmds) {
      await exec(cmd, env);
    };
    
  } catch (error) {
    core.warning(error.message);
  }
}

async function run(): Promise<void> {
  const inputs: Inputs = {
      cmds: JSON.parse(core.getInput("cmds")),
      env: JSON.parse(core.getInput("env")),
  }
  core.info(`Inputs: ${inspect(inputs)}`);

  if (core.getInput("cmdPost")) {
    coreCommand.issueCommand("save-state", { name: "cmdsPost" }, core.getInput("cmdPost"));
  }

  let env = process.env;
  for (const [key, val] of Object.entries(inputs.env)) {
    env[key] = val
  }
  
  if (!inputs.cmds) {
    return;
  }
  await runCmds(inputs.cmds, env)
}

async function post(): Promise<void> {
  try {
    const inputs: Inputs = {
        cmdsPost: JSON.parse(core.getInput("cmdsPost")),
        env: JSON.parse(core.getInput("env")),
    }
    for (let cmd in inputs.cmdsPost) {
      await exec(cmd);
    };
  } catch (error) {
    core.warning(error.message);
  }
}

// Main
if (!process.env["STATE_cmdsPost"]) {
  run();
} // Post
else {
  post();
}
