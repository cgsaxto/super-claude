# Super Claude

An open-source pixel platform adventure with three levels and original synthesized sound effects. Built with Canvas 2D and Web Audio, with no runtime dependencies, external assets, backend, or API keys.

操控橘色角色 Clawd 穿過夜間森林，躲避岩石與流星、踩踏巡邏生物、收集所有 Sparks，再抵達信標。

## 本機啟動

```sh
python3 -m http.server 8000
```

開啟 [localhost:8000](http://localhost:8000/)。需要桌面瀏覽器和鍵盤；目前沒有觸控操作。

## 操作

| 動作 | 按鍵 |
| --- | --- |
| 移動 | A / D 或左右方向鍵 |
| 跳躍 | Space、W 或上方向鍵；短按小跳、長按全跳 |
| 暫停／恢復 | Esc 或 P；切換分頁自動暫停 |
| 音效開關 | M 或右上角喇叭按鈕 |
| 音量 | 右上角滑桿 |
| 開始／面板主要按鈕 | Enter 或點擊按鈕 |

## 玩法

- 三關：Forest Trail、Falling Stars、Before Dawn，必要 Sparks 分別為 8、10、12。
- 收齊本關 Sparks 後信標才會解鎖，抵達信標才能過關。
- 三顆生命；碰岩石、側撞敵人、被流星擊中會受傷，受傷後短暫無敵。
- 從上方下降踩中敵人可擊敗牠並反彈。
- 流星先預警再落地，只在撞擊瞬間判定傷害；跑出範圍或跳得夠高可躲過。
- Ember 增加分數；Heart 回復生命；Shield 抵擋一次傷害，不能保護掉坑。
- 每關兩個檢查點；掉坑扣血並重生，已取得物品不會重新出現。
- Retry level 重玩本關，保留前面關卡成績；Restart adventure 從頭開始。
- 關卡面板有短暫防誤觸等待，遊玩計時不含暫停或面板等待。

## 原創音效

`audio.js` 使用方波、三角波、原創音型及濾波噪聲即時合成音效，不含外部取樣或背景音樂。首次使用者操作後才啟動音訊；音效不可用時遊戲仍可運作。音量與靜音偏好只存在本機 localStorage。

## 開發與驗證

需要 Node.js 20 或更新版本，沒有 npm 套件依賴。

```sh
npm run check
npm test
npm run build
```

建置只把五個必要遊戲檔案複製到 `public/`，不公開測試、文件或本機暫存檔。測試涵蓋三關各 200 個種子的目標數量、岩石禁區與間距，以及種子重現性；它不取代真人試玩或完整瀏覽器通關驗證。

## Vercel 部署

將這個 GitHub repo 匯入 Vercel，選擇 Other。`vercel.json` 已設定 `npm run build` 與輸出目錄 `public`。無需設定環境變數。

## 關卡參數與檔案

- `levels.js`：物理與難度參數 `TUNING`、地形段落、三關、岩石及流星排程。
- `game.js`：輸入、狀態、物理、碰撞、敵人、收集、鏡頭與繪製。
- `audio.js`：音效合成與設定。
- `index.html` / `style.css`：介面和等比例舞台。
- `scripts/build.mjs`：靜態發布建置。
- `tests/levels.test.cjs`：關卡不變條件測試。

`?seed=14` 可重現配置；`?level=2` 可從第二關開始。level 只接受 1–3 的整數，不合法值回到第一關。

`superClaude.state()` 和 `superClaude.snapshot()` 是唯讀除錯介面；舊名稱 `clawdsQuest` 保留為相容別名。

## 已知限制

以桌面 Chrome 與 macOS 瀏覽器環境驗證，尚未完整驗證 Firefox、其他作業系統或觸控裝置。使用者已親自試玩並可通關。三關共用森林背景，巡邏生物只有一種。

## License

[MIT](LICENSE). This is an independent community game and is not affiliated with or endorsed by Anthropic.
