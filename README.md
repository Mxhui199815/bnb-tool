# BNB 批量工具 - 官网部署包

这是用于部署到 GitHub Pages 的静态官网文件，包含：

- `index.html` — 官网首页（功能/档位/下载入口）
- `bnb-batch-transfer.zip` — Windows 版 APP 安装包（用户下载后在本地运行）
- `.nojekyll` — 让 GitHub Pages 跳过 Jekyll 处理（保留 zip 下载）

## 部署步骤

1. 在 GitHub 新建仓库（如 `bnb-tool`，Public）
2. 把本文件夹所有文件推送到 main 分支
3. 仓库 Settings → Pages → Source: Deploy from a branch → main / (root) → Save
4. 等待 1~2 分钟，访问 https://<用户名>.github.io/bnb-tool/

## 更新版本

替换 `bnb-batch-transfer.zip` 和 `index.html` 后重新 push 即可，Pages 会自动更新。
