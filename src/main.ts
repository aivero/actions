import * as core from "@actions/core";
import * as github from "@actions/github";
import { inspect } from "util";
import { promisify } from "util";
import { spawn } from "child_process"
import * as path from "path"

function exec(full_cmd: string) {
  let args = full_cmd.split(' ');
  let cmd = args.shift();
  if (cmd) {
    spawn(cmd, args, { stdio: 'inherit' });
  }
}

async function run(): Promise<void> {
  try {
    const inputs = {
      package: core.getInput("package"),
      version: core.getInput("version"),
      path: core.getInput("path"),
      profile: core.getInput("profile"),
    };
    core.debug(`Inputs: ${inspect(inputs)}`);

    exec(`~/.local/bin/conan config install https://github.com/aivero/conan-config/archive/master.zip -sf conan-config-master`);
    exec(`~/.local/bin/conan config set general.default_profile=${inputs.profile}`);
    exec(`~/.local/bin/conan create ${inputs.path} ${inputs.package}/${inputs.version}@`);

  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}

run();
