import {
  PACKAGE_GIT_DEPENDENCY_MESSAGE,
  commandDownloadsPackages,
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
});

describe('PACKAGE_GIT_DEPENDENCY_MESSAGE', () => {
  it('is the plain message the coordinator approved', () => {
    expect(PACKAGE_GIT_DEPENDENCY_MESSAGE).toBe(
      "This project needs a package from a git address, which the sandbox can't reach yet.",
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
