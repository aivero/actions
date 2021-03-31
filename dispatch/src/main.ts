import * as core from "@actions/core";
import * as github from "@actions/github";
import { RequestParameters } from "@octokit/types";
import simpleGit, { SimpleGit } from "simple-git";
import { inspect } from "util";
import YAML from "yaml";
import fs from "fs";
import * as path from "path";
import hash from "object-hash";
import { parse, createVisitor } from "python-ast";

const CONFIG_NAME = "devops.yml";

interface Inputs {
  token: string;
  repository: string;
  lastRev: string;
  mode: string;
  component: string;
  arguments: string;
}

interface Commands {
  pre: string;
  main: string;
  post: string;
}
interface Instance {
  name: string;
  version: string;
  commit: string;
  branch: string;
  folder: string;
  cmdsPre?: string[];
  cmds?: string[];
  cmdsPost?: string[];
  image?: string;
  tags?: string[];
  mode: SelectMode;
}

interface ConanInstance extends Instance {
  profiles: string[];
  settings?: { string };
  options?: { string };
  bootstrap?: boolean;
  debugPkg?: boolean;
}

interface DockerConfig {
  tag?: string;
  platform?: string;
  dockerfile?: string;
}

interface DockerInstance extends ConanInstance {
  conanInstall?: string[];
  subdir?: string;
  script?: string[];
  docker?: DockerConfig;
}

enum SelectMode {
  Conan = "conan",
  Docker = "docker",
  Command = "command",
  ConanInstallTarball = "conan-install-tarball",
  ConanInstallScript = "conan-install-script",
}

interface Payload {
  tags?: string[];
  image?: string;
  commit: string;
  context: string;
  cmds: Commands;
  component?: string;
  branch?: string;
  profile?: string;
  docker?: DockerConfig;
}

interface Event extends RequestParameters {
  owner: string;
  repo: string;
  event_type: string;
  client_payload: Payload;
}

class Mode {
  args: string;
  repo: string;
  token: string;
  git: SimpleGit;

  constructor(inputs: Inputs) {
    this.args = inputs.arguments;
    this.repo = inputs.repository;
    this.token = inputs.token;
    this.git = simpleGit();
  }

  async getImage(profile: string): Promise<string> {
    // Base Conan image
    let image = "aivero/conan:";

    if (profile.includes("musl")) {
      image += "alpine";
    } else if (profile.includes("linux") || profile.includes("wasi")) {
      image += "bionic";
    } else if (profile.includes("windows")) {
      image += "windows";
    } else if (profile.includes("macos")) {
      image += "macos";
    }

    // Arch options
    if (profile.includes("x86_64") || profile.includes("wasm")) {
      image += "-x86_64";
    } else if (profile.includes("armv8")) {
      image += "-armv8";
    }
    return image;
  }
  async getTags(profile: string): Promise<string[]> {
    let tags = {} as string[];

    // Arch options
    if (profile.includes("x86_64") || profile.includes("wasm")) {
      tags = ["X64", "aws"];
    } else if (profile.includes("armv8")) {
      tags = ["ARM64", "aws"];
    }
    return tags;
  }

  // Parse the profile name to a docker/buildx conform string as per
  // https://github.com/docker/buildx#---platformvaluevalue
  async getDockerPlatform(profile: string): Promise<string> {
    let os = "" as string;
    let arch = "" as string;
    if (profile.includes("Linux") || profile.includes("linux")) {
      os = "linux";
    } else if (profile.includes("Windows") || profile.includes("windows")) {
      throw Error(`Windows builds are not yet supported`);
    } else if (profile.includes("Macos") || profile.includes("macos")) {
      throw Error(`MacOS/Darwin builds are not yet supported`);
    }

    if (profile.includes("armv8") || profile.includes("arm64")) {
      arch = "arm64";
    } else if (profile.includes("armv7") || profile.includes("armhf")) {
      arch = "arm/v7";
    } else if (profile.includes("86_64") || profile.includes("86-64")) {
      arch = "amd64";
    }

    if (!os) {
      throw Error(`Could not parse profile ${profile} to an os.`);
    }
    if (!arch) {
      throw Error(`Could not parse profile ${profile} to an arch.`);
    }
    return `${os}/${arch}`;
  }

  async run() {
    const ints = await this.findInstances();
    await this.dispatchInstances(ints);
  }

  async loadConfigFile(confPath: string): Promise<unknown[]> {
    const confRaw = fs.readFileSync(confPath, "utf8");
    return this.loadConfig(confPath, confRaw);
  }

  async loadConfig(confPath: string, confRaw: string): Promise<unknown[]> {
    const folder = path.dirname(confPath);
    const name = path.basename(folder);
    const conf = YAML.parse(confRaw);
    const ints: Record<string, unknown>[] = [];
    // Empty conf file
    if (conf == null) {
      return ints;
    }
    for (let int of conf) {
      // Empty instance
      if (int == null) {
        int = {};
      }

      // Set git branch and commit
      if (int.branch == undefined) {
        // turn a env.GITHUB_REF from refs/heads/dependabot/some/more to dependabot/some/more
        int.branch = process.env.GITHUB_REF?.split("/").slice(2).join("/");
      }
      if (int.commit == undefined) {
        int.commit = process.env.GITHUB_SHA;
      }

      // Name
      if (int.name == undefined) {
        int.name = name;
      }

      // Version
      if (int.version == undefined) {
        // Set version to commit
        int.version = int.commit;
      }

      // Disable debugPkg by deafault
      if (int.debugPkg == undefined) {
        // Set version to commit
        int.debugPkg = false;
      }

      // Default folder
      if (int.folder) {
        int.folder = path.join(folder, int.folder);
      } else {
        int.folder = folder;
      }

      // Load mode
      int.mode = this.getMode(int);

      ints.push(int);
    }

    return ints;
  }

  async findInstances(): Promise<unknown[]> {
    throw Error("Not implemented!");
  }

  async getBasePayload(int: Instance): Promise<Payload> {
    return {
      image: "node12",
      context: `${int.name}/${int.version} on ${int.branch}`,
      branch: int.branch,
      commit: int.commit,
      component: int.folder,
      cmds: {} as Commands,
    };
  }

  async getConanRepo(int: ConanInstance): Promise<string> {
    const conanfilePath = fs.readFileSync(
      path.join(int.folder, "conanfile.py"),
      "utf8"
    );
    const conanfileAst = parse(conanfilePath);
    let license = "";
    createVisitor({
      shouldVisitNextChild: () => license == "",
      visitExpr_stmt: (expr) => {
        // Find and check expressions: "license = <STRING|TUPLE>"
        if (
          expr.children?.length == 3 &&
          expr.children[1].text == "=" &&
          expr.children[0].text == "license"
        ) {
          license = expr.children[2].text;
        }
      },
    }).visit(conanfileAst);
    if (license == "") {
      throw Error(`No license in '${conanfilePath}'`);
    }
    let conanRepo = "$CONAN_REPO_PUBLIC";
    if (license.includes("Proprietary")) {
      conanRepo = "$CONAN_REPO_INTERNAL";
    }
    return conanRepo;
  }

  async getCommandPayload(int: Instance): Promise<{ [name: string]: Payload }> {
    const payloads: { [name: string]: Payload } = {};
    const payload = await this.getBasePayload(int);
    payload.context = `${int.name}/${int.branch}`;
    payloads[`command: ${int.name}/${int.branch}`] = payload;
    return payloads;
  }

  async getConanCmdPre(profile: string): Promise<string[]> {
    return [
      `conan config install $CONAN_CONFIG_URL -sf $CONAN_CONFIG_DIR`,
      `conan user $CONAN_LOGIN_USERNAME -p $CONAN_LOGIN_PASSWORD -r $CONAN_REPO_ALL`,
      `conan user $CONAN_LOGIN_USERNAME -p $CONAN_LOGIN_PASSWORD -r $CONAN_REPO_INTERNAL`,
      `conan user $CONAN_LOGIN_USERNAME -p $CONAN_LOGIN_PASSWORD -r $CONAN_REPO_PUBLIC`,
      `conan config set general.default_profile=${profile}`,
    ];
  }
  async getConanCmdPost(): Promise<string[]> {
    return [`conan remove --locks`, `conan remove * -f`];
  }

  async getConanPayload(
    int: ConanInstance
  ): Promise<{ [name: string]: Payload }> {
    const payloads: { [name: string]: Payload } = {};
    // Default profiles

    if (int.profiles == undefined) {
      int.profiles = ["linux-x86_64", "linux-armv8"];
    }

    // Create instance for each profile
    for (const profile of int.profiles) {
      const payload = await this.getBasePayload(int);
      payload.profile = profile;

      payload.image = await this.getImage(profile);
      payload.tags = int.tags ?? (await this.getTags(profile));

      // Handle bootstrap packages
      if (int.bootstrap) {
        payload.image += "-bootstrap";
      }

      // Settings
      let args = this.args;
      if (int.settings) {
        for (const [set, val] of Object.entries(int.settings)) {
          args += `-s ${int.name}:${set}=${val} `;
        }
      }
      // Options
      if (int.options) {
        for (const [opt, val] of Object.entries(int.options)) {
          // Convert to Python bool
          const res = val == true ? "True" : val == false ? "False" : val;
          args += `-o ${int.name}:${opt}=${res} `;
        }
      }

      let cmdsPre = int.cmdsPre || [];
      cmdsPre = cmdsPre.concat(await this.getConanCmdPre(profile));
      payload.cmds.pre = JSON.stringify(cmdsPre);

      const cmdsPost = int.cmdsPost || [];
      payload.cmds.post = JSON.stringify(
        cmdsPost.concat(await this.getConanCmdPost())
      );

      // Check if package is proprietary
      const conanRepo = await this.getConanRepo(int);

      let cmds = int.cmds || [];
      cmds.push(`conan create ${args}${int.folder} ${int.name}/${int.version}@`);
      if (int.debugPkg) {
        cmds.push(`conan create ${args}${int.folder} ${int.name}-dbg/${int.version}@`)
      }
      cmds.push(`conan upload ${int.name}/${int.version}@ --all -c -r ${conanRepo}`)
      if (int.debugPkg) {
        cmds.push(`conan upload ${int.name}-dbg/${int.version}@ --all -c -r ${conanRepo}`)
      }
      
      let version = int.version;
      // Upload branch alias for sha commit version
      if (int.version?.match("^[0-9a-f]{40}$")) {
        version = int.branch;
        cmds.push(
          `conan upload ${int.name}/${int.branch}@ --all -c -r ${conanRepo}`
        );
      }
      payload.cmds.main = JSON.stringify(cmds);

      payload.context = `${int.name}/${int.branch}: ${profile} (${hash(
        payload
      )})`;
      payloads[`conan: ${int.name}/${version}: ${profile}`] = payload;
    }
    return payloads;
  }

  async getConanDockerPayload(
    int: DockerInstance
  ): Promise<{ [name: string]: Payload }> {
    const payloads: { [name: string]: Payload } = {};
    if (int.profiles == undefined) {
      int.profiles = ["linux-x86_64", "linux-armv8"];
    }

    if (int.subdir == undefined) {
      int.subdir = "";
    }

    // Create instance for each profile
    for (const profile of int.profiles) {
      const payload = await this.getBasePayload(int);
      payload.profile = profile;

      payload.image = await this.getImage(profile);
      payload.tags = int.tags ?? (await this.getTags(profile));

      // Settings
      let args = this.args;
      if (int.settings) {
        for (const [set, val] of Object.entries(int.settings)) {
          args += ` -s ${int.name}:${set}=${val}`;
        }
      }
      // Options
      if (int.options) {
        for (const [opt, val] of Object.entries(int.options)) {
          // Convert to Python bool
          const res = val == true ? "True" : val == false ? "False" : val;
          args += ` -o ${int.name}:${opt}=${res}`;
        }
      }

      let cmdsPre = int.cmdsPre || [];
      cmdsPre = cmdsPre.concat(await this.getConanCmdPre(profile));
      payload.cmds.pre = JSON.stringify(cmdsPre);

      const cmdsPost = int.cmdsPost || [];
      payload.cmds.post = JSON.stringify(
        cmdsPost.concat(await this.getConanCmdPost())
      );

      // Conan install all specified conan packages to a folder prefixed with install-
      let cmds = int.cmds || [];
      if (int.conanInstall) {
        for (const conanPkgs of int.conanInstall) {
          cmds = cmds.concat([
            `mkdir -p ${int.folder}/install || true`,
            `conan install ${args}${conanPkgs}/${int.branch}@ -if ${int.folder}/install/${conanPkgs}`,
          ]);
        }
      }

      // Add commands
      if (int.mode == SelectMode.ConanInstallScript) {
        const scripts = int.script || [];
        cmds = cmds.concat(scripts);
      }

      // Replace prefix and create tarball
      if (int.conanInstall) {
        for (const pkg of int.conanInstall) {
          cmds = cmds.concat([
            `sed -i s#PREFIX=.*#PREFIX=/${int.subdir}/${pkg}# ${int.folder}/install/${pkg}/${int.subdir}/dddq_environment.sh`,
          ]);
        }
        cmds = cmds.concat([
          `tar -cvjf ${int.folder}/${int.name}-${int.branch}.tar.bz2 ${int.folder}/install`,
        ]);
      }

      payload.cmds.main = JSON.stringify(cmds);

      if (int.mode == SelectMode.Docker) {
        int.docker = int.docker || {};
        payload.docker = payload.docker || {};
        if (int.docker.tag) {
          // todo: consider tagging just like conan: hash and then a second tag one on the git branch/tag
          payload.docker.tag = `${int.docker.tag}:${int.branch}`;
        } else {
          payload.docker.tag = `ghcr.io/aivero/${
            int.name
          }/${profile.toLowerCase()}:${int.branch}`;
        }

        if (int.docker.platform) {
          payload.docker.platform = int.docker.platform;
        } else {
          payload.docker.platform = await this.getDockerPlatform(
            profile.toLowerCase()
          );
        }

        if (int.docker.dockerfile) {
          payload.docker.dockerfile = `${int.folder}/${int.docker.dockerfile}`;
        } else {
          payload.docker.dockerfile = `${int.folder}/docker/${profile}.Dockerfile`;
        }
      }

      payload.context = `${int.name}/${int.branch}: ${profile} (${hash(
        payload
      )})`;
      payloads[`${int.mode}: ${int.name}/${int.branch}: ${profile}`] = payload;
    }

    return payloads;
  }

  async dispatchInstances(ints: unknown[]) {
    core.startGroup("Dispatch instances");

    const [owner, repo] = this.repo.split("/");
    const octokit = github.getOctokit(this.token);

    let payloads: { [name: string]: Payload } = {};
    for (const int of ints) {
      const mode = this.getMode(int as Instance);
      switch (mode) {
        case SelectMode.Conan:
          payloads = await this.getConanPayload(int as ConanInstance);
          break;
        case SelectMode.Command:
          payloads = await this.getCommandPayload(int as Instance);
          break;
        case SelectMode.Docker:
          payloads = await this.getConanDockerPayload(int as ConanInstance);
          break;
        case SelectMode.ConanInstallTarball:
          payloads = await this.getConanDockerPayload(int as ConanInstance);
          break;
        case SelectMode.ConanInstallScript:
          payloads = await this.getConanDockerPayload(int as ConanInstance);
          break;
        default:
          throw Error(`Mode '${mode}' is not supported yet.`);
      }

      for (const [event_type, client_payload] of Object.entries(payloads)) {
        const event: Event = {
          owner,
          repo,
          event_type,
          client_payload,
        };
        core.info(`${inspect(event.client_payload)}`);
        await octokit.repos.createDispatchEvent(event);
        const status = {
          owner,
          repo,
          sha: client_payload.commit,
          state: "pending" as const,
          context: client_payload.context,
        };
        await octokit.repos.createCommitStatus(status);
      }
    }
    core.endGroup();
  }

  getMode(int: Instance): SelectMode {
    if (!int.mode) {
      if (fs.existsSync(path.join(int.folder as string, "conanfile.py"))) {
        return SelectMode.Conan;
      } else if (fs.existsSync(path.join(int.folder as string, "Dockerfile"))) {
        return SelectMode.Docker;
      } else if (int.cmds) {
        return SelectMode.Command;
      }
      throw Error(`Could not detect mode for folder: ${int.folder}`);
    }
    return int.mode;
  }
}

class GitMode extends Mode {
  lastRev: string;

  constructor(inputs: Inputs) {
    super(inputs);
    this.lastRev = inputs.lastRev || "HEAD^";
  }

  async findConfig(dir: string): Promise<string | undefined> {
    while (dir != ".") {
      const confPath = path.join(dir, CONFIG_NAME);
      if (fs.existsSync(confPath)) {
        return confPath;
      }
      dir = path.dirname(dir);
    }
    return undefined;
  }

  async findInstances(): Promise<unknown[]> {
    core.startGroup("Git Mode: Create instances from changed files in git");
    const ints: unknown[] = [];
    const intsHash = new Set<string>();
    // Compare to previous commit
    core.info('running this.git.diffSummary(["HEAD", this.lastRev]);');
    const diff = await this.git.diffSummary(["HEAD", this.lastRev]);
    core.info('finished running this.git.diffSummary(["HEAD", this.lastRev]);');
    for (const d of diff.files) {
      let filePath = d.file;
      // Handle file renaming
      if (filePath.includes(" => ")) {
        core.info(`Renamed: ${filePath} `);
        filePath = filePath.replace(/{(.*) => .*}/, "$1");
      }

      // Only handle files that exist in current commit
      if (!fs.existsSync(filePath)) {
        continue;
      }

      const file = path.basename(filePath);
      const fileDir = path.dirname(filePath);
      const confPath = await this.findConfig(fileDir);
      if (!confPath) {
        core.info(`Couldn't find ${CONFIG_NAME} for file: ${file}`);
        continue;
      }

      let intsNew: unknown[];
      if (file == CONFIG_NAME) {
        intsNew = await this.handleConfigChange(filePath);
      } else {
        intsNew = await this.handleFileChange(confPath, filePath);
      }
      for (const int of intsNew) {
        const intHash = hash(int);
        if (!intsHash.has(intHash)) {
          intsHash.add(intHash);
          ints.push(int);
        }
      }
    }
    core.endGroup();
    return ints;
  }

  async handleConfigChange(confPath: string): Promise<unknown[]> {
    // New config.yml
    core.info("running this.git.show([`HEAD:${confPath}`]));");
    const confNew = await this.loadConfig(
      confPath,
      await this.git.show([`HEAD:${confPath}`])
    );
    core.info('running this.git.raw(["ls - tree", " - r", this.lastRev]);');
    const filesOld = await this.git.raw(["ls-tree", "-r", this.lastRev]);
    if (!filesOld.includes(confPath)) {
      core.info(`Created: ${confPath}`);
      for (const int of confNew) {
        const intHash = hash(int);
        const { name, version } = int as Instance;
        core.info(
          `Instance name/version (hash): ${name}/${version} (${intHash})`
        );
      }
      return confNew;
    }
    // Compare to old config.yml
    core.info(`Changed: ${confPath}`);
    const ints: unknown[] = [];
    const confOld = await this.loadConfig(
      confPath,
      await this.git.show([`${this.lastRev}:${confPath}`])
    );
    const hashsOld = [...confOld].map((int) => hash(int));
    for (const intNew of confNew) {
      // Check if instance existed in old commit or if instance data changed
      if (!hashsOld.includes(hash(intNew))) {
        const intHash = hash(intNew);
        const { name, version } = intNew as Instance;
        core.info(
          `Instance name/version (hash): ${name}/${version} (${intHash})`
        );
        ints.push(intNew);
      }
    }
    return ints;
  }

  async handleFileChange(
    confPath: string,
    filePath: string
  ): Promise<unknown[]> {
    const ints: unknown[] = [];
    const conf = await this.loadConfigFile(confPath);
    for (const int of conf) {
      const { name, version, folder } = int as Instance;
      if (path.join(folder).endsWith(path.dirname(filePath))) {
        const intHash = hash(int);
        core.info(
          `Instance name/version (hash): ${name}/${version} (${intHash})`
        );
        ints.push(int);
      }
    }
    return ints;
  }
}

class ManualMode extends Mode {
  component: string;

  constructor(inputs: Inputs) {
    super(inputs);
    this.component = inputs.component;
  }

  async findInstances(): Promise<unknown[]> {
    core.startGroup("Manual Mode: Create instances from manual input");
    const ints: unknown[] = [];
    // in: recipes/rabbitmq-broker/* out: recipes/rabbitmq-broker
    // in: deepserver/* out: deepserver
    const inputName: string = this.component.split("/").slice(0, -1).join("/");
    // in: recipes/rabbitmq-broker/* out: *
    const inputVersion: string = this.component.split("/").pop() as string;
    const confPaths = (
      await this.git.raw(["ls-files", "**/devops.yml", "--recurse-submodules"])
    )
      .trim()
      .split("\n");

    for (const confPath of confPaths) {
      const confInts = await this.loadConfigFile(confPath);
      for (const int of confInts) {
        const { name, version } = int as Instance;
        if (
          (inputName != "*" && !name.includes(inputName)) ||
          (inputVersion != "*" && inputVersion != version)
        ) {
          continue;
        }
        const intHash = hash(ints);
        core.info(
          `Build component/version (hash): ${name}/${version} (${intHash})`
        );
        ints.push(int);
      }
    }
    core.endGroup();
    return ints;
  }
}

class AliasMode extends Mode {
  constructor(inputs: Inputs) {
    super(inputs);
  }

  async findInstances(): Promise<unknown[]> {
    core.startGroup("Alias Mode: Create alias for all package");
    const ints: unknown[] = [];

    const confPaths = (await this.git.raw(["ls-files", "**/devops.yml"]))
      .trim()
      .split("\n");

    for (const confPath of confPaths) {
      const confInts = await this.loadConfigFile(confPath);
      for (const int of confInts) {
        const { name, version } = int as Instance;
        // Only create alias for component with commit sha as version
        if (!version?.match("^[0-9a-f]{40}$")) {
          continue;
        }
        const intHash = hash(ints);
        core.info(
          `Alias component/version (hash): ${name}/${version} (${intHash})`
        );
        ints.push(int);
      }
    }
    core.endGroup();
    return ints;
  }

  async dispatchInstances(ints: unknown[]) {
    core.startGroup("Dispatch instances");

    const [owner, repo] = this.repo.split("/");
    const octokit = github.getOctokit(this.token);

    const cmdsComplete = {} as Commands;
    cmdsComplete.pre = JSON.stringify([
      `conan config install $CONAN_CONFIG_URL -sf $CONAN_CONFIG_DIR`,
      `conan user $CONAN_LOGIN_USERNAME -p $CONAN_LOGIN_PASSWORD -r $CONAN_REPO_ALL`,
      `conan user $CONAN_LOGIN_USERNAME -p $CONAN_LOGIN_PASSWORD -r $CONAN_REPO_INTERNAL`,
      `conan user $CONAN_LOGIN_USERNAME -p $CONAN_LOGIN_PASSWORD -r $CONAN_REPO_PUBLIC`,
    ]);
    const cmds: string[] = [];
    for (const int of ints) {
      const { name, version, branch } = int as ConanInstance;
      const conanRepo = await this.getConanRepo(int as ConanInstance);
      // Create branch alias for sha commit versions
      if (version.match("^[0-9a-f]{40}$")) {
        cmds.push(`conan alias ${name}/${version} ${name}/${branch}`);
        cmds.push(`conan upload ${name}/${branch}@ --all -c -r ${conanRepo}`);
      }
    }
    cmdsComplete.main = JSON.stringify(cmds);
    const client_payload: Payload = {
      image: "aivero/conan:bionic-x86_64",
      tags: ["X64"],
      cmds: cmdsComplete,
      commit: "",
      context: "Alias: */*",
    };
    const event: Event = {
      owner,
      repo,
      event_type: "Create branch alias for all Conan packages",
      client_payload,
    };
    core.info(`${inspect(event.client_payload)}`);
    await octokit.repos.createDispatchEvent(event);
    core.endGroup();
  }
}

async function run(): Promise<void> {
  try {
    // Handle inputs
    const inputs: Inputs = {
      token: core.getInput("token"),
      repository: core.getInput("repository"),
      lastRev: core.getInput("lastRev"),
      mode: core.getInput("mode"),
      component: core.getInput("component"),
      arguments: core.getInput("arguments"),
    };
    core.startGroup("Inputs");
    core.info(`Inputs: ${inspect(inputs)}`);
    core.endGroup();

    let mode: Mode;
    if (inputs.mode == "" || inputs.mode == "git") {
      mode = new GitMode(inputs);
    } else if (inputs.mode == "manual") {
      mode = new ManualMode(inputs);
    } else if (inputs.mode == "alias") {
      mode = new AliasMode(inputs);
    } else {
      throw Error(`Unsupported mode: ${inputs.mode}`);
    }
    await mode.run();
  } catch (error) {
    core.debug(inspect(error));
    core.setFailed(error.message);
  }
}

run();
