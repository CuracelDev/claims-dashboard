export const DEFAULT_PRISM_CHANNEL = 'C06DVSADD6J';
export const DEFAULT_PRISM_USER_ID = 'U0AF86M8TRS';

export function getPrismConfig() {
  return {
    token: process.env.SLACK_BOT_TOKEN,
    postToken: process.env.SLACK_PRISM_RELAY_TOKEN || process.env.SLACK_BOT_TOKEN,
    channel: process.env.SLACK_PRISM_CHANNEL_ID || DEFAULT_PRISM_CHANNEL,
    prismUserId: process.env.SLACK_PRISM_USER_ID || DEFAULT_PRISM_USER_ID,
    prismBotId: process.env.SLACK_PRISM_BOT_ID || null,
    dashboardUrl: process.env.NEXT_PUBLIC_APP_URL || 'https://claims-dashboard.vercel.app',
  };
}

export async function slackPost(method, body) {
  const { postToken } = getPrismConfig();
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${postToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function slackGet(method, params) {
  const { token } = getPrismConfig();
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

export function isPrismSlackMessage(message = {}) {
  const { prismUserId, prismBotId } = getPrismConfig();
  return message.user === prismUserId || (prismBotId && message.bot_id === prismBotId);
}

export function cleanSlackText(text) {
  return (text || '').replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();
}
