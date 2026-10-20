import {
  PACKAGE_GIT_DEPENDENCY_MESSAGE,
  commandDownloadsPackages,
  findCommandLineGitDependency,
  findGitDependency,
  packageDownloadCardWhat,
  splitShellCommands,
} from '../../../src/core/sandbox/packageMirrors';

describe('splitShellCommands', () => {
  it('splits on shell operators and keeps quoted words whole', () => {
    expect(splitShellCommands('cd app && pip install "some pkg"; ls')).toEqual([
      ['cd', 'app'],
      ['pip', 'install', 'some pkg'],
      ['ls'],
    ]);
  });

  it('keeps a pipe inside quotes inside its segment', () => {
    expect(splitShellCommands('echo "a|b" | wc -c')).toEqual([
      ['echo', 'a|b'],
      ['wc', '-c'],
    ]);
  });
});

describe('commandDownloadsPackages', () => {
  it.each([
    'pip install requests',
    'pip3 install -r requirements.txt',
    'python3 -m pip install flask',
    'cd app && npm ci',
    'npm install',
    'npm i lodash',
    'pnpm add vitest',
    'yarn install',
    'cargo build --release',
    'cargo test',
    'cargo fetch',
    'go mod download',
    'go build ./...',
    'go test ./...',
    'uv pip install httpx',
    'poetry install',
    'FOO=bar pip install requests',
    'sudo npm install -g typescript',
  ])('recognises %s as a download command', command => {
    expect(commandDownloadsPackages(command)).toBe(true);
  });

  it.each([
    'ls -la',
    'pip list',
    'pip --version',
    'npm run build',
    'npm test',
    'cargo --version',
    'go version',
    'git status',
    'python3 train.py',
    'echo pip install requests',
    'grep -r "npm install" .',
  ])('does not treat %s as a download command', command => {
    expect(commandDownloadsPackages(command)).toBe(false);
  });
});

describe('findGitDependency', () => {
  it('finds a git+https dependency in requirements.txt', () => {
    const hit = findGitDependency([
      { name: 'requirements.txt', content: 'requests==2.32.0\ngit+https://github.com/example/lib.git@v1.0\n' },
    ]);
    expect(hit?.file).toBe('requirements.txt');
  });

  it('finds a git dependency in pyproject.toml', () => {
    const hit = findGitDependency([
      {
        name: 'pyproject.toml',
        content: '[project]\ndependencies = ["lib @ git+https://github.com/example/lib@main"]\n',
      },
    ]);
    expect(hit?.file).toBe('pyproject.toml');
  });

  it('finds a cargo git dependency', () => {
    const hit = findGitDependency([
      { name: 'Cargo.toml', content: '[dependencies]\nserde = { git = "https://github.com/serde-rs/serde" }\n' },
    ]);
    expect(hit?.file).toBe('Cargo.toml');
  });

  it('finds npm git specs in package.json dependencies only', () => {
    const content = JSON.stringify({
      homepage: 'https://github.com/example/project',
      repository: { type: 'git', url: 'git+https://github.com/example/project.git' },
      dependencies: { leftpad: 'github:example/leftpad' },
    });
    const hit = findGitDependency([{ name: 'package.json', content }]);
    expect(hit?.file).toBe('package.json');
    expect(hit?.line).toContain('leftpad');
  });

  it('finds an npm user/repo shorthand dependency', () => {
    const content = JSON.stringify({ dependencies: { widget: 'example/widget#v2' } });
    expect(findGitDependency([{ name: 'package.json', content }])?.file).toBe('package.json');
  });

  it('ignores registry specs, file specs and links outside dependencies', () => {
    const content = JSON.stringify({
      homepage: 'https://github.com/example/project',
      dependencies: { react: '^19.0.0', local: 'file:../local', tarball: 'https://example.com/t-1.0.tgz' },
    });
    expect(findGitDependency([{ name: 'package.json', content }])).toBeUndefined();
    expect(
      findGitDependency([
        { name: 'requirements.txt', content: 'requests==2.32.0\nnumpy>=2\n./local-wheel.whl\n' },
        { name: 'Cargo.toml', content: '[dependencies]\nserde = { version = "1", features = ["derive"] }\n' },
      ]),
    ).toBeUndefined();
  });

  it('survives a broken package.json', () => {
    expect(findGitDependency([{ name: 'package.json', content: '{not json' }])).toBeUndefined();
  });

  it.each([
    ['a bare ssh url', 'ssh://git@github.com/org/repo.git'],
    ['an scp-style address', 'git@github.com:org/repo.git'],
    ['a bare git protocol url', 'git://github.com/org/repo'],
  ])('finds %s in package.json dependencies', (_name, spec) => {
    const content = JSON.stringify({ dependencies: { a: spec } });
    expect(findGitDependency([{ name: 'package.json', content }])?.file).toBe('package.json');
  });

  it('finds a git spec in package.json overrides', () => {
    const content = JSON.stringify({
      dependencies: { a: '1.0.0' },
      overrides: { b: 'git+https://github.com/org/repo' },
    });
    expect(findGitDependency([{ name: 'package.json', content }])?.file).toBe('package.json');
  });

  it('finds a git spec nested inside package.json overrides', () => {
    const content = JSON.stringify({
      overrides: { a: { b: 'git@github.com:org/repo.git' } },
    });
    expect(findGitDependency([{ name: 'package.json', content }])?.file).toBe('package.json');
  });

  it('finds a git spec in pnpm overrides and in resolutions', () => {
    const pnpmContent = JSON.stringify({ pnpm: { overrides: { b: 'ssh://git@github.com/org/repo.git' } } });
    expect(findGitDependency([{ name: 'package.json', content: pnpmContent }])?.file).toBe('package.json');
    const resolutionsContent = JSON.stringify({ resolutions: { b: 'git+ssh://git@github.com/org/repo.git' } });
    expect(findGitDependency([{ name: 'package.json', content: resolutionsContent }])?.file).toBe('package.json');
  });

  it('ignores registry specs in package.json overrides', () => {
    const content = JSON.stringify({
      overrides: { b: '^2.0.0', c: { d: 'npm:other@1.0.0' } },
      pnpm: { overrides: { e: '3.0.0' } },
      resolutions: { f: '1.0.0' },
    });
    expect(findGitDependency([{ name: 'package.json', content }])).toBeUndefined();
  });

  it.each([
    ['an uppercase scheme', 'GIT+HTTPS://github.com/org/repo'],
    ['an hg vcs line', 'hg+https://bitbucket.org/org/repo'],
    ['an svn vcs line', 'svn+https://example.net/org/repo'],
    ['a bzr vcs line', 'bzr+https://example.net/org/repo'],
    ['a bare git protocol line', 'git://github.com/org/repo'],
    ['a direct reference to a github archive', 'pkg @ https://github.com/org/repo/archive/main.zip'],
    ['a direct reference to a wheel on the package site', 'pkg @ https://files.pythonhosted.org/x.whl'],
  ])('finds %s in requirements.txt', (_name, line) => {
    expect(findGitDependency([{ name: 'requirements.txt', content: line }])?.file).toBe('requirements.txt');
  });

  it('ignores a direct reference to a file inside the project', () => {
    expect(
      findGitDependency([{ name: 'requirements.txt', content: 'pkg @ file:./wheels/pkg-1.0-py3-none-any.whl' }]),
    ).toBeUndefined();
  });

  it('ignores a direct reference to a file at an absolute path', () => {
    expect(
      findGitDependency([
        { name: 'requirements.txt', content: 'pkg @ file:///home/user/wheels/pkg-1.0-py3-none-any.whl' },
      ]),
    ).toBeUndefined();
  });

  it('ignores an editable install of a project on this machine', () => {
    expect(findGitDependency([{ name: 'requirements.txt', content: '-e file:///home/user/project' }])).toBeUndefined();
  });

  it('ignores a pyproject direct reference to a file at an absolute path', () => {
    const hit = findGitDependency([
      {
        name: 'pyproject.toml',
        content: '[project]\ndependencies = ["pkg @ file:///home/user/wheels/pkg-1.0-py3-none-any.whl"]\n',
      },
    ]);
    expect(hit).toBeUndefined();
  });

  it('ignores a package.json file dependency at an absolute path', () => {
    const content = JSON.stringify({ dependencies: { local: 'file:///home/user/project' } });
    expect(findGitDependency([{ name: 'package.json', content }])).toBeUndefined();
  });

  it.each([
    ['a current-directory path', './lib'],
    ['a parent-directory path', '../shared'],
    ['an absolute path', '/abs/path'],
  ])('ignores %s as a package.json dependency', (_name, spec) => {
    const content = JSON.stringify({ dependencies: { local: spec } });
    expect(findGitDependency([{ name: 'package.json', content }])).toBeUndefined();
  });

  it('ignores local paths in package.json overrides, and still finds git specs there', () => {
    const local = JSON.stringify({ overrides: { local: '../shared' } });
    expect(findGitDependency([{ name: 'package.json', content: local }])).toBeUndefined();
    const git = JSON.stringify({ overrides: { lib: 'example/lib' } });
    expect(findGitDependency([{ name: 'package.json', content: git }])?.file).toBe('package.json');
  });
});

describe('findCommandLineGitDependency', () => {
  it.each([
    ['a pip git spec', 'pip install git+https://github.com/org/repo', 'git+https://github.com/org/repo'],
    [
      'a pip git spec over ssh',
      'pip install git+ssh://git@github.com/org/repo.git',
      'git+ssh://git@github.com/org/repo.git',
    ],
    ['a pip hg spec', 'pip install hg+https://bitbucket.org/org/repo', 'hg+https://bitbucket.org/org/repo'],
    ['a pip bare ssh address', 'pip install ssh://git@github.com/org/repo.git', 'ssh://git@github.com/org/repo.git'],
    ['a pip editable git spec', 'pip install -e git+https://github.com/org/repo', 'git+https://github.com/org/repo'],
    [
      'a web address as the package',
      'pip install https://files.pythonhosted.org/pkg-1.0.tar.gz',
      'https://files.pythonhosted.org/pkg-1.0.tar.gz',
    ],
    ['an npm shorthand', 'npm i github:org/repo', 'github:org/repo'],
    ['an npm user/repo shorthand', 'npm install org/repo', 'org/repo'],
    ['an npm scp-style address', 'npm install git@github.com:org/repo.git', 'git@github.com:org/repo.git'],
    ['a cargo git option', 'cargo add serde --git https://github.com/org/repo', 'https://github.com/org/repo'],
    [
      'a git spec in a later command',
      'npm ci && pip install git+https://github.com/org/repo',
      'git+https://github.com/org/repo',
    ],
  ])('finds %s', (_name, command, expected) => {
    expect(findCommandLineGitDependency(command)).toBe(expected);
  });

  it.each([
    'pip install requests',
    'pip install requests>=2',
    'pip install "requests[security]>=2"',
    'pip install ./lib',
    'pip install ../shared',
    'pip install /abs/path/pkg-1.0-py3-none-any.whl',
    'pip install --index-url https://example.com/simple requests',
    'pip install --index-url=https://example.com/simple requests',
    'pip install -r requirements.txt',
    'pip install --requirement https://example.com/requirements.txt',
    'npm install --registry https://registry.example.com lodash',
    'npm install lodash@1.2.3',
    'npm ci',
    'go get github.com/org/mod@v1.2.3',
    'go test -run TestThing/SubTest ./...',
    'cargo build --release',
    'cargo add serde --features derive',
    'git clone https://github.com/org/repo',
    'pip install requests && git clone https://github.com/org/repo',
    'echo git+https://github.com/org/repo',
    'ls -la',
  ])('leaves %s alone', command => {
    expect(findCommandLineGitDependency(command)).toBeUndefined();
  });
});

describe('PACKAGE_GIT_DEPENDENCY_MESSAGE', () => {
  it('is the plain message the coordinator approved, with its one next step', () => {
    expect(PACKAGE_GIT_DEPENDENCY_MESSAGE).toBe(
      "This project needs a package from a git address, which the sandbox can't reach yet. " +
        "Replace it with the package's name and version from the package registry, then try again.",
    );
  });
});

describe('packageDownloadCardWhat', () => {
  it('names only the sites the command actually uses', () => {
    expect(packageDownloadCardWhat('pip install requests')).toBe(
      "Aman wants to download this project's packages from the public package sites (PyPI).",
    );
    expect(packageDownloadCardWhat('npm ci')).toBe(
      "Aman wants to download this project's packages from the public package sites (npm).",
    );
    expect(packageDownloadCardWhat('go build ./...')).toBe(
      "Aman wants to download this project's packages from the public package sites (the Go package site).",
    );
    expect(packageDownloadCardWhat('cargo build')).toBe(
      "Aman wants to download this project's packages from the public package sites (crates.io).",
    );
  });

  it('lists each site once, in the order the command uses them', () => {
    expect(packageDownloadCardWhat('pip install requests && npm ci && pip install flask')).toBe(
      "Aman wants to download this project's packages from the public package sites (PyPI, npm).",
    );
  });

  it('is undefined for a command that downloads nothing', () => {
    expect(packageDownloadCardWhat('ls -la')).toBeUndefined();
    expect(packageDownloadCardWhat('python3 script.py')).toBeUndefined();
    expect(packageDownloadCardWhat('git status')).toBeUndefined();
  });
});
