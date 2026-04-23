const fetch = require("node-fetch");
require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const noblox = require("noblox.js");

async function sendToDashboard(data) {
    try {
        await fetch("https://v0-sjc-bot1.vercel.app/api/logs", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.BOT_API_KEY}`
            },
            body: JSON.stringify({
                executor: data.executor,
                target: data.target || null,
                command: data.command,
                success: data.success,
                reason: data.reason || null,
                proof: data.proof || null,
                timestamp: new Date().toISOString()
            })
        });
    } catch (err) {
        console.error("Failed to send to dashboard:", err);
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ================= PERMISSIONS =================
const PERMISSIONS = [
    { minRank: 253, maxRank: 255, promote: true, demote: true, accept: true, kick: true, ban: true, warn: true, history: true, allInfoCommands: true, targetMaxRank: 255 },
    { minRank: 250, maxRank: 252, promote: true, demote: true, accept: true, kick: true, ban: true, warn: true, history: true, allInfoCommands: true, targetMaxRank: 150 },
    { minRank: 110, maxRank: 150, promote: true, demote: true, accept: true, kick: true, ban: false, warn: true, history: true, allInfoCommands: true, targetMaxRank: 50 },
    { minRank: 49, maxRank: 50, promote: true, demote: true, accept: true, kick: false, ban: false, warn: false, history: true, allInfoCommands: true, targetMaxRank: 39 },
    { minRank: 47, maxRank: 47, promote: true, demote: true, accept: true, kick: false, ban: false, warn: false, history: true, allInfoCommands: true, targetMaxRank: 39 }
];

const ADMINS = ["ugohvpjvpjv", "jogchum6"];

// ================= GROUP CONFIG =================
const GROUPS = Object.keys(process.env)
    .filter(k => k.startsWith("GROUP_"))
    .map(key => {
        const name = key.split("_")[1];
        return {
            name,
            groupId: parseInt(process.env[key]),
            commandChannel: process.env[`COMMAND_CHANNEL_${name}`],
            logChannel: process.env[`LOG_CHANNEL_${name}`],
            botLogChannel: process.env[`BOT_LOG_CHANNEL_${name}`],
            tryoutChannel: process.env[`TRYOUT_LOGS_CHANNEL_${name}`]
        };
    });

// ================= STATE =================
let globalLock = false;
const userLocks = new Set();
const usage = {}; // {username: {count, reset}}

// ================= COMMAND LIST =================
const COMMANDS = [
    "!promote", "!demote", "!accept", "!kick", "!ban", "!userinfo",
    "!groupinfo", "!pendingrequests", "!history", "!warn",
    "!clearlogs", "!rankinfo", "!allcommands", "!mycommands",
    "!emergencylock", "!emergencyunlock"
];

// ================= LOGIN =================
client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await noblox.setCookie(process.env.ROBLOX_COOKIE);
});

// ================= HELPERS =================
function getPermission(rank) {
    return PERMISSIONS.find(p => rank >= p.minRank && rank <= p.maxRank);
}

function checkUsage(user) {
    const now = Date.now();
    if (!usage[user] || now > usage[user].reset) {
        usage[user] = { count: 0, reset: now + 86400000 };
    }
    if (usage[user].count >= 3) return false;
    usage[user].count++;
    return true;
}

async function getExecutor(member, groupId) {
    if (!member.nickname) throw "Set your nickname to Roblox username";
    const userId = await noblox.getIdFromUsername(member.nickname);
    const rank = await noblox.getRankInGroup(groupId, userId);
    return { userId, rank, username: member.nickname };
}

async function getRoleByName(groupId, name) {
    const roles = await noblox.getRoles(groupId);
    return roles.find(r => r.name.toLowerCase() === name.toLowerCase());
}

// ================= STRICT LOG CHECK =================
async function checkPromotionDemotionLog(channel, username, currentRank, newRank) {
    const messages = await channel.messages.fetch({ limit: 100 });
    return messages.some(msg => {
        return msg.content.includes(`Username: ${username}`) &&
               msg.content.includes(`Current Rank: ${currentRank}`) &&
               msg.content.includes(`New Rank: ${newRank}`);
    });
}

async function checkAcceptLog(channel, username) {
    const messages = await channel.messages.fetch({ limit: 100 });

    // Convert to array and sort newest → oldest
    const sorted = Array.from(messages.values())
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

    for (const msg of sorted) {
        const content = msg.content;

        const match = content.match(/Attendee Roblox Name:\s*(.+)/i);
        if (!match) continue;

        const loggedUser = match[1]
            .replace(/[`*_~]/g, "")
            .trim()
            .toLowerCase();

        if (loggedUser === username.toLowerCase()) {
            // ✅ FIRST MATCH = MOST RECENT VALID LOG
            return true;
        }
    }

    return false;
}

// ================= LOGGING =================
async function logBot(channelId, data) {
    const ch = await client.channels.fetch(channelId);
    const embed = new EmbedBuilder()
        .setTitle(`Command Log: ${data.command}`)
        .addFields(
            { name: "Executor", value: data.executor },
            { name: "Target", value: data.target || "N/A" },
            { name: "Result", value: data.success ? "✅ SUCCESS" : "❌ FAILED" },
            { name: "Reason", value: data.reason || "None" }
        )
        .setColor(data.success ? 0x00ff00 : 0xff0000)
        .setTimestamp();
    await ch.send({ embeds: [embed] });
}

// ================= MAIN =================
client.on("messageCreate", async message => {
    if (!message.content.startsWith("!") || message.author.bot) return;

    const group = GROUPS.find(g => g.commandChannel === message.channel.id);
    if (!group) return;

    const args = message.content.trim().split(/\s+/);
    const cmd = args[0].toLowerCase();

    let result = {
    command: cmd,
    executor: message.author.id,
    target: args[1] || null,
    success: false,
    reason: null,
    proof: null
};

    try {
        // ===== LOCKS =====
        if (globalLock && !ADMINS.includes(message.member.nickname))
            throw "System is locked";
        if (userLocks.has(message.member.nickname))
            throw "You are locked";

        const executor = await getExecutor(message.member, group.groupId).catch(() => null);
        const perm = executor ? getPermission(executor.rank) : null;
        const logChannel = await client.channels.fetch(group.logChannel);

        // ================= PROMOTE =================
        if (cmd === "!promote") {
            if (!perm || !perm.promote) throw "You don't have permission to promote";
            const user = args[1];
            const newRankName = args.slice(2).join(" ");
            const id = await noblox.getIdFromUsername(user);
            const currentRank = await noblox.getRankNameInGroup(group.groupId, id);
            const newRole = await getRoleByName(group.groupId, newRankName);
            if (!newRole) throw "Rank not found";

            const valid = await checkPromotionDemotionLog(logChannel, user, currentRank, newRole.name);

result.proof = `Username: ${user}, From: ${currentRank}, To: ${newRole.name}`;

if (!valid) {
    throw "No valid promotion log found";
}

            if (!checkUsage(message.member.nickname)) {
                userLocks.add(message.member.nickname);
                throw "Exceeded daily usage limit";
            }

            await noblox.setRank(group.groupId, id, newRole.rank);
            await message.reply(`✅ Promoted ${user} → ${newRole.name}`);
            result.success = true;
        }

        // ================= DEMOTE =================
        else if (cmd === "!demote") {
            if (!perm || !perm.demote) throw "You don't have permission to demote";
            const user = args[1];
            const newRankName = args.slice(2).join(" ");
            const id = await noblox.getIdFromUsername(user);
            const currentRank = await noblox.getRankNameInGroup(group.groupId, id);
            const newRole = await getRoleByName(group.groupId, newRankName);
            if (!newRole) throw "Rank not found";

            const valid = await checkPromotionDemotionLog(logChannel, user, currentRank, newRole.name);

result.proof = `Username: ${user}, From: ${currentRank}, To: ${newRole.name}`;

if (!valid) {
    throw "No valid promotion log found";
}

            if (!checkUsage(message.member.nickname)) {
                userLocks.add(message.member.nickname);
                throw "Exceeded daily usage limit";
            }

            await noblox.setRank(group.groupId, id, newRole.rank);
            await message.reply(`✅ Demoted ${user} → ${newRole.name}`);
            result.success = true;
        }

        // ================= ACCEPT =================
        else if (cmd === "!accept") {
    if (!perm || !perm.accept) throw "You don't have permission to accept";

    const user = args[1];
    if (!user) throw "Provide a username";

    const id = await noblox.getIdFromUsername(user);

    // ✅ USE TRYOUT LOG CHANNEL (NOT logChannel)
    const tryoutChannel = await client.channels.fetch(group.tryoutChannel);

    // (optional but recommended) small delay to ensure message is fetched
    await new Promise(res => setTimeout(res, 1000));

    const valid = await checkAcceptLog(tryoutChannel, user);

    result.proof = `Attendee Roblox Name: ${user}`;

    if (!valid) {
        throw new Error("No valid accept log found");
    }

    await noblox.handleJoinRequest(group.groupId, id, true);
    await message.reply(`✅ Accepted join request: ${user}`);
    result.success = true;
}

        // ================= KICK =================
        else if (cmd === "!kick") {
            if (!perm || !perm.kick) throw "You don't have permission to kick";
            const user = args[1];
            const id = await noblox.getIdFromUsername(user);
            await noblox.setRank(group.groupId, id, 1); // Guest
            await message.reply(`✅ Kicked ${user} from group`);
            result.success = true;
        }

        // ================= BAN =================
        else if (cmd === "!ban") {
            if (!perm || !perm.ban) throw "You don't have permission to ban";
            const user = args[1];
            const id = await noblox.getIdFromUsername(user);
            await noblox.ban(group.groupId, id);
            await message.reply(`✅ Banned ${user} from group`);
            result.success = true;
        }

        // ================= USERINFO =================
        else if (cmd === "!userinfo") {
            const user = args[1];
            const id = await noblox.getIdFromUsername(user);
            const rank = await noblox.getRankNameInGroup(group.groupId, id);

            const friends = await noblox.getFriends(id);
            const followers = await noblox.getFollowers(id);

            const profileLink = `https://www.roblox.com/users/${id}/profile`;

            const embed = new EmbedBuilder()
                .setTitle(`${user} Info`)
                .setDescription(`[Roblox Profile](${profileLink})`)
                .addFields(
                    { name: "User ID", value: id.toString(), inline: true },
                    { name: "Rank", value: rank, inline: true },
                    { name: "Friends", value: friends.length.toString(), inline: true },
                    { name: "Followers", value: followers.length.toString(), inline: true }
                )
                .setColor(0x3498db)
                .setTimestamp()
                .setFooter({ text: `Requested by ${message.author.username}` });

            await message.channel.send({ embeds: [embed] });
            result.success = true;
        }

        // ================= GROUPINFO =================
        else if (cmd === "!groupinfo") {
            const info = await noblox.getGroup(group.groupId);

            const embed = new EmbedBuilder()
                .setTitle(info.name)
                .setDescription(info.description || "No description")
                .addFields(
                    { name: "Group ID", value: group.groupId.toString(), inline: true },
                    { name: "Owner", value: info.owner?.name || "Unknown", inline: true }
                )
                .setColor(0x2ecc71)
                .setTimestamp()
                .setFooter({ text: `Requested by ${message.author.username}` });

            await message.channel.send({ embeds: [embed] });
            result.success = true;
        }

        // ================= PENDING REQUESTS =================
        else if (cmd === "!pendingrequests") {
            let requests = [];
            let cursor = "";

            do {
                const page = await noblox.getJoinRequests({
                    group: group.groupId,
                    sortOrder: "Asc",
                    limit: 100,
                    cursor
                });

                requests.push(...page.data);
                cursor = page.nextPageCursor;
            } while (cursor);

            const embed = new EmbedBuilder()
                .setTitle("Pending Join Requests")
                .setColor(requests.length ? 0xf1c40f : 0x95a5a6)
                .setTimestamp()
                .setFooter({ text: `Requested by ${message.author.username}` });

            if (!requests.length) embed.setDescription("No pending requests");
            else requests.forEach(r => embed.addFields({ name: r.requester.username, value: r.requester.userId.toString(), inline: true }));

            await message.channel.send({ embeds: [embed] });
            result.success = true;
        }

        // ================= HISTORY =================
        else if (cmd === "!history") {
            if (!perm || !perm.history) throw "You don't have permission to view history";
            const user = args[1];
            const id = await noblox.getIdFromUsername(user);

            let cursor = "";
            let found = [];

            do {
                const logPage = await noblox.getAuditLog({
                    group: group.groupId,
                    userId: id,
                    sortOrder: "Desc",
                    limit: 100,
                    cursor
                });

                logPage.data.forEach(entry => {
                    if (entry.actionType === "ChangeRank") {
                        found.push(`${entry.actor.name}: ${entry.message}`);
                    }
                });

                cursor = logPage.nextPageCursor;
            } while (cursor);

            const embed = new EmbedBuilder()
                .setTitle(`${user} Rank History`)
                .setDescription(found.length ? found.join("\n") : "No rank changes found")
                .setColor(0x9b59b6)
                .setTimestamp()
                .setFooter({ text: `Requested by ${message.author.username}` });

            await message.channel.send({ embeds: [embed] });
            result.success = true;
        }

        // ================= WARN =================
        else if (cmd === "!warn") {
            if (!perm || !perm.warn) throw "You don't have permission to warn";
            const user = args[1];
            const reason = args.slice(2).join(" ") || "No reason provided";

            await logBot(group.botLogChannel, {
                command: "warn",
                executor: message.author.id,
                target: user,
                success: true,
                reason
            });
            await message.reply(`⚠️ Warned ${user}: ${reason}`);
            result.success = true;
        }

        // ================= CLEARLOGS =================
        else if (cmd === "!clearlogs") {
            if (!ADMINS.includes(message.member.nickname)) throw "You don't have permission to clear logs";
            const ch = await client.channels.fetch(group.botLogChannel);
            const messages = await ch.messages.fetch({ limit: 100 });
            await ch.bulkDelete(messages);
            await message.reply("✅ Cleared last 100 log messages");
            result.success = true;
        }

        // ================= RANKINFO =================
        else if (cmd === "!rankinfo") {
            const user = args[1];
            const id = await noblox.getIdFromUsername(user);
            const rankName = await noblox.getRankNameInGroup(group.groupId, id);
            const rankId = await noblox.getRankInGroup(group.groupId, id);

            await message.reply(`${user} has rank **${rankName}** (${rankId})`);
            result.success = true;
        }

        // ================= ALLCOMMANDS / MYCOMMANDS =================
        else if (cmd === "!allcommands") {
            await message.reply(`Available commands: ${COMMANDS.join(", ")}`);
            result.success = true;
        }
        else if (cmd === "!mycommands") {
            const myCmds = COMMANDS.filter(c => {
                if (!perm) return ADMINS.includes(message.member.nickname) ? COMMANDS : [];
                if (c === "!promote") return perm.promote;
                if (c === "!demote") return perm.demote;
                if (c === "!accept") return perm.accept;
                if (c === "!kick") return perm.kick;
                if (c === "!ban") return perm.ban;
                if (c === "!warn") return perm.warn;
                if (c === "!history") return perm.history;
                if (c === "!userinfo" || c === "!pendingrequests" || c === "!rankinfo") return perm.allInfoCommands || true;
                return ADMINS.includes(message.member.nickname);
            });

            const embed = new EmbedBuilder()
                .setTitle("Your Available Commands")
                .setDescription(myCmds.join("\n"))
                .setColor(0x1abc9c)
                .setTimestamp()
                .setFooter({ text: `Requested by ${message.author.username}` });

            await message.channel.send({ embeds: [embed] });
            result.success = true;
        }

        // ================= EMERGENCYLOCK / UNLOCK =================
        else if (cmd === "!emergencylock") {
            if (!args[1]) {
                globalLock = true;
                await message.reply("🔒 Emergency lock: all non-admins locked");
                result.success = true;
            } else {
                const target = args[1];
                userLocks.add(target);
                await message.reply(`🔒 ${target} has been locked`);
                result.success = true;
            }
        }
        else if (cmd === "!emergencyunlock") {
            globalLock = false;
            userLocks.clear();
            await message.reply("🔓 Emergency unlock: all users unlocked");
            result.success = true;
        }

        // ================= UNKNOWN COMMAND =================
        else {
            await message.reply("❌ Command not recognized");
        }

    } catch (err) {
        result.reason = err.toString();
        await message.reply(`❌ Failed: ${err}`);
    }

    await logBot(group.botLogChannel, result);
await sendToDashboard(result);
});

client.login(process.env.DISCORD_TOKEN);
