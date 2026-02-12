# TouchAI

TouchAI 是一款基于Tauri开发的极简桌面 AI 工具，愿景是 AI 一触即达，为用户提供极速的桌面AI体验。

## 技术栈

- 前端：Vue 3 + TypeScript + TailwindCSS
- 后端：Rust + Tauri 2.0
- 构建工具：Vite + pnpm

## 开发

```bash

# 安装依赖
pnpm install

# 开发运行
pnpm tauri dev

# 开发运行（启用 MCP Bridge 自动化测试）
pnpm run tauri:dev:mcp

# 构建应用
pnpm tauri build
```

## 许可证

GNU General Public License v3.0
