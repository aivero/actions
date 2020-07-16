import { spawn } from "child_process";

function sleep(millis) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

async function exec(full_cmd: string) {
  let args = full_cmd.split(' ');
  let cmd = args.shift();
  if (!cmd) {
    throw new Error(`Invalid command: '${full_cmd}'`);
  }
  console.log(`Running command '${cmd}' with args: '${args}'`)
  const child = await spawn(cmd, args, {});

  for await (const chunk of child.stdout) {
    process.stdout.write(chunk);
  }
  for await (const chunk of child.stderr) {
    process.stderr.write(chunk);
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.on('close', resolve);
  });

  if (exitCode) {
    throw new Error(`Command '${cmd}' failed with code: ${exitCode}`);
  }
}

export { exec, sleep };