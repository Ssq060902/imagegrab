# 图提取 ImageGrab · 官网

纯静态宣传单页，无需构建工具与后端。

## 本地预览

双击 `index.html` 即可在浏览器打开；或在该目录启动任意静态服务器，例如：

```
python -m http.server 8000
# 访问 http://localhost:8000
```

## 修改主色调

所有颜色变量集中在 `css/style.css` 顶部的 `:root` 中，改这两行即可全局换色：

```css
--primary: #4f7cff;    /* 主色（蓝） */
--primary-2: #8b5cf6;  /* 渐变辅色（紫） */
```

## 修改文案

- 标语 / 功能介绍 / 安装步骤：直接编辑 `index.html` 对应区块的文本
- 页脚版权与平台说明：`index.html` 底部 `<footer>`；年份由 `js/main.js` 自动更新
