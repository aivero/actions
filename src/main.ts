import * as core from "@actions/core";
import * as github from "@actions/github";
import simpleGit from "simple-git";
import { inspect } from "util";
import YAML from "yaml";
import fs from "fs";
import { promisify } from "util";
import { exec } from "child_process"
import * as path from "path"
const exec_prom = promisify(exec);

async function run(): Promise<void> {
  try {
    // Handle inputs
    const inputs = {
      token: core.getInput("token"),
      repository: core.getInput("repository"),
      path: core.getInput("path"),
    };
    core.debug(`Inputs: ${inspect(inputs)}`);
    const [owner, repo] = inputs.repository.split("/");
    const octokit = github.getOctokit(inputs.token);
    const repo_path = inputs.path

    // Compare to previous commit
    const git = simpleGit(repo_path);
    const diff = await git.diffSummary(["HEAD", "HEAD^"]);

    // Find package versions that needs to be build
    const build_versions: { [pkg: string]: Set<string> } = {};
    for (const f of diff.files) {
      const [root, pkg, conf_or_ver] = f.file.split("/");
      if (!(pkg in build_versions)) {
        build_versions[pkg] = new Set<string>();
      }

      // Only handle changed files in recipe folder and
      // only handle files that exist in current commit
      if (root != "recipes" || !fs.existsSync(path.join(repo_path, f.file))) {
        continue;
      }

      // Handle config.yml changes
      if (conf_or_ver == "config.yml") {
        // New config.yml
        const conf_new = YAML.parse(await git.show(["HEAD:" + f.file]));
        const files_old = await git.raw(["ls-tree", "-r", "HEAD^"]);
        if (!files_old.includes(f.file)) {
          Object.keys(conf_new.versions).forEach((version) =>
            build_versions[pkg].add(version)
          );
          continue;
        }
        // Compare to old config.yml
        const conf_old = YAML.parse(await git.show(["HEAD^:" + f.file]));
        Object.keys(conf_new.versions).forEach((version) => {
          // Check if version existed in old commit or
          // check if folder name changed for version
          if (
            version in conf_old.versions === false ||
            conf_new.versions[version].folder !=
            conf_old.versions[version].folder
          ) {
            build_versions[pkg].add(version);
          }
        });
      } else {
        // Handle {pkg-name}/{pkg-version}/* changes
        const conf = YAML.parse(
          await git.show(["HEAD:recipes/" + pkg + "/config.yml"])
        );
        Object.keys(conf.versions).forEach((version) => {
          if (conf.versions[version].folder == conf_or_ver) {
            build_versions[pkg].add(version);
          }
        });
      }
    }
    // Extract build settings (os, arch, profile)
    for (const [pkg, versions] of Object.entries(build_versions)) {
      for (const version of versions) {
        const conf = YAML.parse(
          await git.show(["HEAD:recipes/" + pkg + "/config.yml"])
        );
        const folder = conf.versions[version].folder;
        const { stdout, stderr } = await exec_prom(
          `conan inspect ${path.join(repo_path, 'recipes', pkg, folder)}`
        );
        core.debug(stderr);
        const recipe = YAML.parse(stdout);

        const combinations: { tags; profile }[] = [];
        if ('os' in recipe.settings) {
          recipe.settings.os.forEach((os) => {
            switch (os) {
              case "Linux":
                recipe.settings.arch.forEach((arch) => {
                  const tags = ["ubuntu-18.04"];
                  if (arch == "armv8") {
                    tags.push("ARM64");
                  }
                  combinations.push({
                    tags: tags,
                    profile: `Linux-${arch}`,
                  });
                });
                break;
              case "Windows":
                combinations.push({
                  tags: ["windows-latest"],
                  profile: "Windows-x86_64",
                });
                break;
              case "Macos":
                combinations.push({
                  tags: ["macos-latest"],
                  profile: "Macos-x86_64",
                });
                break;
              case "Wasi":
                combinations.push({
                  tags: ["ubuntu-18.04"],
                  profile: "Wasi-wasm",
                });
                break;
            }
          });
        } else {
          // Build cross os/arch packages on Linux x86_64
          combinations.push({ tags: [], profile: `Linux-x86_64` });
        }

        // Dispatch Conan events
        combinations.forEach(async (comb) => {
          const payload = {
            package: pkg,
            version: version,
            folder: ['recipes', pkg, folder],
            tags: comb.tags,
            profile: comb.profile,
            ref: process.env.GITHUB_REF,
            sha: process.env.GITHUB_SHA,
          };
          core.debug(`${inspect(payload)}`);
          await octokit.repos.createDispatchEvent({
            owner: owner,
            repo: repo,
            event_type: "conan",
            client_payload: payload,
          });
        });
      }
    }
  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}

run();
