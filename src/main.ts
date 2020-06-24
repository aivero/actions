import * as core from "@actions/core";
import * as github from "@actions/github";
import { inspect } from "util";
import { promisify } from "util";
import { exec } from "child_process"
import { version } from "os";
const exec_prom = promisify(exec);

async function run(): Promise<void> {
  try {
    const inputs = {
      package: core.getInput("package"),
      version: core.getInput("version"),
      folder: core.getInput("folder"),
      profile: core.getInput("profile"),
    };
    core.debug(`Inputs: ${inspect(inputs)}`);

    await exec_prom(`conan config install https://github.com/aivero/conan-config/archive/master.zip`)
    await exec_prom(`conan config set general.default_profile=linux_${inputs.profile}`)
    await exec_prom(`conan create ${inputs.folder} ${inputs.package}/${inputs.version}`)

  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}

run();
