'use strict';
/*
 * Email delivery abstraction.
 *   - If SMTP is configured (config.mail.smtp), send via nodemailer.
 *   - Otherwise use a DEV transport that logs the message and writes it to
 *     data/outbox/<ts>-<to>.txt, so verification/reset flows are fully testable
 *     locally without a real mailbox.
 * The rest of the app just calls send({to, subject, text}).
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('./logger');

let transporter = null;
function getTransport() {
    if (transporter) return transporter;
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport(config.mail.smtp);
    return transporter;
}

async function send({ to, subject, text }) {
    if (config.mail.smtp) {
        await getTransport().sendMail({ from: config.mail.from, to, subject, text });
        logger.info('email sent (smtp)', { to, subject });
        return;
    }
    // dev transport
    const dir = path.resolve(__dirname, '..', '..', 'data', 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(to).replace(/[^a-z0-9@._-]/gi, '_');
    const file = path.join(dir, `${Date.now()}-${safe}.txt`);
    fs.writeFileSync(file, `To: ${to}\nSubject: ${subject}\n\n${text}\n`);
    logger.info(`email (dev transport) written to ${file}`, { to, subject });
}

module.exports = { send, smtpEnabled: () => !!config.mail.smtp };
