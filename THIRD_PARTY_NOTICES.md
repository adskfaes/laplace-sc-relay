# 第三方软件说明

- **LAPLACE Login Sync SDK** 由 LAPLACE Live! 发布，采用 AGPL-3.0-only。`laplace-sc-replay/vendor/login-sync/` 包含 `@laplace.live/login-sync` 1.2.1 的运行文件及原许可证。对应的 TypeScript 源码、构建脚本和许可位于 [third-party/login-sync](third-party/login-sync)。构建入口是该目录 `package.json` 中的 `build` 脚本。 [上游发布源码](https://github.com/laplace-live/login-sync/tree/3d8c3420397d7a36c831aa98de1e6e1594fe8108/packages/login-sync)
- **LAPLACE Login Sync Server** 由 LAPLACE Live! 发布，采用 AGPL-3.0-only。仓库内的 [服务端源码](login-sync-local/upstream) 原样保留了上游核心处理文件及其许可证。`login-sync-local/server.mjs` 是此扩展项目的本机启动和访问控制代码。 [上游服务端源码](https://github.com/laplace-live/login-sync/tree/b70df855c033f741f333c9c6b60bae8078af6813/apps/server)
- 本机服务安装时由 npm 按 [锁文件](login-sync-local/package-lock.json) 下载运行时依赖，各依赖适用各自的许可证。
- **LAPLACE Event Bridge Server** 由 LAPLACE Live! 发布。安装脚本从上游发布页下载 0.3.21 的 Windows x64 二进制并校验 SHA-256。仓库提供安装脚本。 [上游发布及源码](https://github.com/laplace-live/event-bridge/releases/tag/%40laplace.live%2Fevent-bridge-server%400.3.21)
