AIR SPACE AI 高評分改款延伸網站

用途
1. 保留原本功能一：支線、通路、品類的暢銷/滯銷標籤分析。
2. 功能二改為：上傳參考款式圖，輸入改款說明，按「生成延伸款式」後由 OpenAI 產生延伸款。
3. AI 生成出的延伸款會再套用原本圖片評分邏輯，顯示分數、原因、保留元素、新增元素與相似款參考。

上傳到 GitHub / Render 時請保留結構
- server.mjs
- package.json
- render.yaml
- public/index.html
- public/data/app_data.json
- public/assets/item_web
- public/assets/pdf_pages

Render 環境變數
- OPENAI_API_KEY：你的 OpenAI API Key
- OPENAI_MODEL：gpt-4.1-mini
- OPENAI_IMAGE_MODEL：gpt-image-1

操作流程
1. 進入功能二「AI 高評分改款延伸」。
2. 上傳參考款式圖。
3. 在說明欄輸入希望保留或延伸的方向。
4. 按「生成延伸款式」。
5. 等 AI 產生延伸款並自動評分。
