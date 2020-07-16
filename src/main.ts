import * as core from "@actions/core";
import { inspect } from "util";
import { spawn } from "child_process";
import * as coreCommand from '@actions/core/lib/command'

function sleep(millis) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

async function exec(full_cmd: string) {
  let args = full_cmd.split(' ');
  let cmd = args.shift();
  if (!cmd) {
    throw new Error(`Invalid command: '${full_cmd}'`);
  }
  core.startGroup(`Running command: '${full_cmd}'`)
  const child = await spawn(cmd, args, {});

  for await (const chunk of child.stdout) {
    core.info(chunk);
  }
  for await (const chunk of child.stderr) {
    core.debug(chunk);
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.on('close', resolve);
  });
  core.endGroup();

  if (exitCode) {
    throw new Error(`Command '${cmd}' failed with code: ${exitCode}`);
  }
}

async function run(): Promise<void> {
  // Always run post
  coreCommand.issueCommand('save-state', { name: 'isPost' }, 'true')
  try {
    const inputs = {
      package: core.getInput("package"),
      path: core.getInput("path"),
      profile: core.getInput("profile"),
      conan_repo: core.getInput("conan_repo"),
    };
    core.info(`Inputs: ${inspect(inputs)}`);

    const conan_path = `${process.env.HOME}/.local/bin/conan`;
    await exec(`${conan_path} config install ${process.env.CONAN_CONFIG_URL} -sf ${process.env.CONAN_CONFIG_DIR}`);
    await exec(`${conan_path} user ${process.env.CONAN_LOGIN_USERNAME} -p ${process.env.CONAN_LOGIN_PASSWORD} -r ${inputs.conan_repo}`);
    await exec(`${conan_path} config set general.default_profile=${inputs.profile}`);
    await exec(`${conan_path} create -u ${inputs.path} ${inputs.package}@`);
    await exec(`${conan_path} upload ${inputs.package} --all -c -r ${inputs.conan_repo}`);

  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}

async function post(): Promise<void> {
  try {
    const conan_path = `${process.env.HOME}/.local/bin/conan`;
    await exec(`${conan_path} remove --locks`);
  } catch (error) {
    core.warning(error.message)
  }
}

// Main
if (!process.env['STATE_isPost']) {
  run()
}
// Post
else {
  post()
}
