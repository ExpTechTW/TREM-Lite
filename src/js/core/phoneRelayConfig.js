// 全球手機測站中繼網路的連線設定，index 渲染程序（phoneRelay.js）跟設定頁
// （setting/main.js，純粹用來顯示狀態）都會用到，集中放一份避免兩邊寫死不同步。
module.exports = {
  RELAY_URL: 'https://trem-lite-phone-relay-nexuxai.vercel.app/api/relay',
  RELAY_KEY: 'trem-lite-phone-relay-v1-proto',
};
