const path = require("node:path");

// PM2 상시구동 설정.
// cwd 를 agent/ 로 지정하므로 dist/index.js, .env, ../data 경로가 모두 성립한다.
// (비밀값은 dotenv 가 agent/.env 에서 런타임에 읽으므로 PM2 에 넣지 않는다.)
module.exports = {
  apps: [
    {
      name: "asahi-assistant",
      script: "dist/index.js",
      cwd: path.resolve(__dirname, "..", "agent"),
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      env: { NODE_ENV: "production" },
    },
  ],
};
