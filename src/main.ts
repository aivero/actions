import * as core from "@actions/core";
import * as github from "@actions/github";
import simpleGit from "simple-git";
import { inspect } from "util";
import YAML from "yaml";
import fs from "fs";
import * as path from "path";
import hash from "object-hash";

async function run(): Promise<void> {
  try {
    // Handle inputs
    const inputs = {
      token: core.getInput("token"),
      repository: core.getInput("repository"),
      repository_path: core.getInput("repository_path"),
    };
    core.debug(`Inputs: ${inspect(inputs)}`);
    const [owner, repo] = inputs.repository.split("/");
    const octokit = github.getOctokit(inputs.token);
    const repo_path = inputs.repository_path || "";

    // Compare to previous commit
    const git = simpleGit(repo_path);
    const diff = await git.diffSummary(["HEAD", "HEAD^"]);

    // Find package versions that needs to be build
    core.startGroup("Find package versions that needs to be build");
    const build_versions: { [pkg: string]: Set<string> } = {};
    for (const f of diff.files) {
      let file = f.file;
      // Handle file renaming
      if (file.includes(" => ")) {
        core.info(`Renamed: ${file}`);
        file = file.replace(/{(.*) => .*}/, "$1");
      }
      const [root, pkg, conf_or_ver] = file.split("/");

      // Only handle changed files in recipe folder and
      // only handle files that exist in current commit
      if (root != "recipes" || !fs.existsSync(path.join(repo_path, file))) {
        continue;
      }

      // Create set with package versions to be build
      if (!(pkg in build_versions)) {
        build_versions[pkg] = new Set<string>();
      }

      // Handle config.yml changes
      if (conf_or_ver == "config.yml") {
        // New config.yml
        const conf_new = YAML.parse(await git.show(["HEAD:" + file]));
        const files_old = await git.raw(["ls-tree", "-r", "HEAD^"]);
        if (!files_old.includes(file)) {
          core.info(`Created: ${pkg}/config.yml`);
          conf_new.forEach((build) => {
            let pkg_hash = hash(build);
            core.info(
              `Build pkg/ver (hash): ${pkg}/${build.version} (${pkg_hash})`,
            );
            build_versions[pkg].add(pkg_hash);
          });
          continue;
        }
        // Compare to old config.yml
        core.info(`Changed: ${pkg}/config.yml`);
        const conf_old = YAML.parse(await git.show(["HEAD^:" + file]));
        conf_new.forEach((build) => {
          // Check if build existed in old commit or if build data changed
          let pkg_hash = hash(build);
          let old_pkg_hashs = new Set<string>();
          conf_old.forEach((build) => {
            old_pkg_hashs.add(hash(build));
          });
          if (!old_pkg_hashs.has(pkg_hash)) {
            core.info(
              `Build pkg/ver (hash): ${pkg}/${build.version} (${pkg_hash})`,
            );
            build_versions[pkg].add(pkg_hash);
          }
        });
      } else {
        // Handle {pkg-name}/{pkg-version}/* changes
        const conf = YAML.parse(
          await git.show([`HEAD:recipes/${pkg}/config.yml`]),
        );
        conf.forEach((build) => {
          let folder = "all";
          if ("folder" in build) {
            folder = build.folder;
          }
          if (folder == conf_or_ver) {
            let pkg_hash = hash(build);
            core.info(
              `Build pkg/ver (hash): ${pkg}/${build.version} (${pkg_hash})`,
            );
            build_versions[pkg].add(pkg_hash);
          }
        });
      }
    }
    core.endGroup();

    // Extract build settings (os, arch, profile)
    for (const [pkg, pkg_hashs] of Object.entries(build_versions)) {
      // Extract settings from conanfile as yaml
      const conf = YAML.parse(
        await git.show([`HEAD:recipes/${pkg}/config.yml`]),
      );

      for (const pkg_hash of pkg_hashs) {
        const index = conf.findIndex((build) => hash(build) == pkg_hash);

        // Version
        let version = conf[index].version;

        // Default folder
        let folder = "all";
        if ("folder" in conf[index]) {
          folder = conf[index].folder;
        }

        // Default profiles
        let profiles = [
          "Linux-x86_64",
          "Linux-armv8",
        ];
        if ("profiles" in conf[index]) {
          profiles = conf[index].profiles;
        }

        // Get build combinations
        const combinations: { tags; profile; image }[] = [];
        profiles.forEach((profile) => {
          let image = "aivero/conan:";
          let tags = ["x64"];

          // OS options
          if (profile.includes("musl")) {
            image += "alpine";
          } else if (profile.includes("Linux") || profile.includes("Wasi")) {
            image += "bionic";
          } else if (profile.includes("Windows")) {
            image += "windows";
          } else if (profile.includes("Macos")) {
            image += "macos";
          }

          // Arch options
          if (profile.includes("x86_64") || profile.includes("wasm")) {
            image += "-x86_64";
          } else if (profile.includes("armv8")) {
            image += "-armv8";
            tags = ["ARM64"];
          }

          // Handle bootstrap packages
          if (pkg.startsWith("bootstrap-")) {
            image += "-bootstrap";
          }

          combinations.push({
            tags: tags,
            profile: profile,
            image: image,
          });
        });

        // Dispatch Conan events
        core.startGroup("Dispatch Conan Events");
        combinations.forEach(async (comb) => {
          const payload = {
            package: `${pkg}/${version}`,
            path: path.join("recipes", pkg, folder),
            tags: comb.tags,
            profile: comb.profile,
            conan_repo: "aivero-public",
            docker_image: comb.image,
            ref: process.env.GITHUB_REF,
            sha: process.env.GITHUB_SHA,
          };
          core.info(`${inspect(payload)}`);
          await octokit.repos.createDispatchEvent({
            owner: owner,
            repo: repo,
            event_type: "conan",
            client_payload: payload,
          });
        });
        core.endGroup();
      }
    }
  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}

run();
