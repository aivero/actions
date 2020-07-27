import * as core from "@actions/core";
import { inspect } from "util";
import { spawn } from "child_process";
import * as coreCommand from '@actions/core/lib/command'

function sleep(millis) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

async function exec(full_cmd: string, fail_on_error = true) {
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
  core.endGroup();

  for await (const chunk of child.stderr) {
    if (fail_on_error) {
      core.error(chunk.toString('utf8'));
    } else {
      core.info(chunk.toString('utf8'));
    }
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.on('close', resolve);
  });

  if (exitCode && fail_on_error) {
    throw new Error(`Command '${full_cmd}' failed with code: ${exitCode}`);
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

    // Upload dev and dbg packages
    let [name, version] = inputs.package.split("/");
    await exec(`${conan_path} upload ${name}-dev/${version} --all -c -r ${inputs.conan_repo}`, false);
    await exec(`${conan_path} upload ${name}-dbg/${version} --all -c -r ${inputs.conan_repo}`, false);

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
