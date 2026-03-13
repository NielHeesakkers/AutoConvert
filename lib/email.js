const fs = require('fs');
const { MSMTPRC_PATH } = require('./config');

function writeMsmtprc(smtp) {
  const lines = [
    'account default',
    `host ${smtp.host}`,
    `port ${smtp.port}`,
    'auth on',
    `user ${smtp.user}`,
    `password ${smtp.password}`,
    `tls ${smtp.tls ? 'on' : 'off'}`,
    `tls_starttls ${smtp.starttls ? 'on' : 'off'}`,
    `from ${smtp.from}`,
    '',
  ];
  fs.writeFileSync(MSMTPRC_PATH, lines.join('\n'), { mode: 0o600 });
}

module.exports = { writeMsmtprc };
