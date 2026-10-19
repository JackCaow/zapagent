# Web Agent 移动真机验收

移动端交付分成两层，不能用桌面浏览器缩放替代真机签收：

1. `acceptance-web-agent-browser.cjs` 的 390×844 Chromium 门禁，阻止横向溢出、Composer 被裁切和两个抽屉失效；
2. iOS Safari 与 Android Chrome 各一台真实设备，验证浏览器系统行为、触控、软键盘和前后台恢复。

## 真机矩阵

| 平台 | 最低设备 | 必验场景 |
| --- | --- | --- |
| iOS Safari | 当前受支持 iOS 的真实 iPhone | 邀请打开/登录、发送、软键盘收起、侧栏、Outcome、下载、锁屏恢复、刷新恢复 |
| Android Chrome | 当前受支持 Android 的真实手机 | 企业或邀请登录、发送、返回键关闭抽屉、Outcome、下载、切后台恢复、刷新恢复 |

两台设备都必须在生产同源 HTTPS 地址完成以下步骤：

1. 用独立的限时邀请或测试 OIDC 用户登录，确认地址栏不再保留邀请 fragment；
2. 创建新对话，发送一个会产生文件的真实 Agent 任务，等待终态；
3. 打开 Conversation 抽屉切换对话，标题与桌面端一致；
4. 打开 Outcome，预览并下载产物，关闭抽屉后 Composer 仍可见；
5. 输入多行文本并唤起软键盘，页面不得横向滚动，发送按钮不得被永久遮挡；
6. 运行中锁屏或切后台至少 60 秒，再返回并确认 SSE 自动恢复且事件不重复；
7. 刷新页面，确认登录态、当前对话、持久化标题、Task 终态和结果可恢复；
8. 退出登录，浏览器后退不得重新显示 Workspace 数据。

## 证据格式

每个平台保留一份 owner-only JSON 和必要截图：

```json
{
  "schema_version": 1,
  "status": "passed",
  "platform": "ios-safari",
  "device": "physical",
  "os_version": "record-at-test-time",
  "browser_version": "record-at-test-time",
  "source_sha": "git-sha",
  "deployment_id": "railway-deployment-id",
  "project_id": "non-secret-project-id",
  "task_id": "accepted-task-id",
  "checks": {
    "login": true,
    "composer_keyboard": true,
    "conversation_title_cross_device": true,
    "drawers": true,
    "artifact_download": true,
    "background_resume": true,
    "refresh_restore": true,
    "logout_back_navigation": true
  }
}
```

证据不得包含邀请 token、Cookie、OIDC code、模型密钥、prompt、完整输出或用户邮箱。只有 iOS 和 Android 两份 JSON 都为 `passed`，才能把“移动真机验收”标为完成；自动化移动视口通过只能标为“门禁已就绪”。
