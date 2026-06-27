'use strict';
/*
 * Account lifecycle business logic that sits alongside auth: email verification
 * and password reset. Kept separate from auth.service (register/login/session)
 * for cohesion; auth.service.register calls issueVerification here.
 */
const bcrypt = require('bcryptjs');
const config = require('../config');
const users = require('../repositories/user.repo');
const tokenRepo = require('../repositories/token.repo');
const sessions = require('../repositories/session.repo');
const tokenService = require('./token.service');
const mailer = require('../utils/mailer');
const logger = require('../utils/logger');
const { tooManyRequests, badRequest } = require('../utils/errors');

const VERIFY = 'email_verify';
const RESET = 'password_reset';

function verifyLink(raw) { return `${config.appBaseUrl}/verify.html?token=${encodeURIComponent(raw)}`; }
function resetLink(raw) { return `${config.appBaseUrl}/reset.html?token=${encodeURIComponent(raw)}`; }

// Throttle token requests: a short cooldown between sends + a per-window cap.
function assertWithinLimits(userId, type) {
    const recent = tokenRepo.recentCount({ userId, type, windowMs: config.tokens.windowMs });
    if (recent >= config.tokens.maxPerWindow) {
        throw tooManyRequests('Too many requests. Please try again later.', 'TOKEN_RATE_LIMIT');
    }
    const latest = tokenRepo.latest(userId, type);
    if (latest) {
        const age = Date.now() - new Date(latest.created_at + 'Z').getTime();
        if (age >= 0 && age < config.tokens.resendCooldownMs) {
            throw tooManyRequests('Please wait before requesting another email.', 'RESEND_COOLDOWN');
        }
    }
}

async function issueVerification(user, { throttle = true } = {}) {
    if (user.email_verified) return { alreadyVerified: true };
    if (throttle) assertWithinLimits(user.id, VERIFY);
    const { raw } = tokenService.issue(user.id, VERIFY, config.tokens.verifyTtlMs);
    const link = verifyLink(raw);
    await mailer.send({
        to: user.email,
        subject: 'Verify your email',
        text: `Hi ${user.username},\n\nConfirm your email to finish setting up your account:\n${link}\n\nThis link expires in ${Math.round(config.tokens.verifyTtlMs / 3600000)} hours. If you didn't sign up, ignore this email.`,
    });
    logger.security('verification email issued', { userId: user.id });
    return { devLink: config.mail.devPreview ? link : undefined };
}

function verifyEmail(rawToken) {
    const userId = tokenService.consume(rawToken, VERIFY);
    if (!userId) throw badRequest('Invalid or expired verification link', 'INVALID_TOKEN');
    users.markVerified(userId);
    logger.security('email verified', { userId });
    return users.publicView(users.findById(userId));
}

// Resend for the currently-authenticated user.
async function resendVerification(user) {
    return issueVerification(user, { throttle: true });
}

// Password-reset request. ALWAYS resolves the same way regardless of whether the
// email exists (no user enumeration). Only sends mail when the account exists.
async function requestPasswordReset(email) {
    const user = users.findByEmail(email);
    if (user) {
        try {
            assertWithinLimits(user.id, RESET);
            const { raw } = tokenService.issue(user.id, RESET, config.tokens.resetTtlMs);
            const link = resetLink(raw);
            await mailer.send({
                to: user.email,
                subject: 'Reset your password',
                text: `Hi ${user.username},\n\nReset your password using the link below:\n${link}\n\nThis link expires in ${Math.round(config.tokens.resetTtlMs / 60000)} minutes. If you didn't request this, you can safely ignore it.`,
            });
            logger.security('password reset requested', { userId: user.id });
            return { devLink: config.mail.devPreview ? link : undefined };
        } catch (e) {
            // Swallow rate-limit errors here too, so timing/response can't reveal
            // whether the address exists.
            logger.warn('password reset suppressed', { reason: e.code || e.message });
        }
    }
    return {};
}

async function resetPassword(rawToken, newPassword) {
    const userId = tokenService.consume(rawToken, RESET);
    if (!userId) throw badRequest('Invalid or expired reset link', 'INVALID_TOKEN');
    const hash = await bcrypt.hash(newPassword, config.bcryptRounds);
    users.setPassword(userId, hash);
    sessions.deleteForUser(userId); // force re-login everywhere after a reset
    logger.security('password reset completed', { userId });
}

module.exports = {
    issueVerification, verifyEmail, resendVerification,
    requestPasswordReset, resetPassword,
};
