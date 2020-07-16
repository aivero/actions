import * as core from "@actions/core";
import { exec } from "./common"

async function post(): Promise<void> {
  try {
    const conan_path = `${process.env.HOME}/.local/bin/conan`;
    await exec(`${conan_path} remove --locks`);
  } catch (error) {
    core.warning(error.message)
  }
}

post()
