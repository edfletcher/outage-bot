'use strict';

const fs = require('fs');
const path = require('path');
const inq = require('inquirer');
const config = require('config');
const logger = require('./logger');
const irc = require('irc-framework');
const RssParser = require('rss-parser');
const { consistentId, floodProtect, fmtDuration } = require('./util');

const stats = {
  upSince: new Date(),
  announced: 0
};

const serviceSpecificParsers = {
  aws: (feedObj) => {
    return {
      items: feedObj.items.map(x => ({ outageBotId: consistentId(x.pubDate, x.isoDate, x.guid), ...x })),
      next: feedObj.ttl
    };
  },

  azure: (feedObj) => {
    return {
      items: feedObj.items
    };
  },

  gcp: (feedObj) => {
    return {
      items: feedObj.items.map(x => ({ outageBotId: consistentId(x.pubDate, x.isoDate, x.id), ...x }))
    };
  },

  oracle: (feedObj) => {
    return {
      items: feedObj.items.map(x => ({ outageBotId: consistentId(x.pubDate, x.isoDate, x.guid), ...x }))
    };
  }
};

const serviceSpecificRenderers = {
  aws: (item) => {
    return `AWS event at ${item.pubDate}: "${item.title}" -- ${item.guid}`;
  },

  azure: (item) => {
    return `Azure event at ${item.pubDate}: "${item.title}" -- ${item.link}`;
  },

  gcp: (item) => {
    return `GCP event at ${new Date(item.pubDate).toLocaleString()}: "${item.title}" -- ${item.link}`;
  },

  oracle: (item) => {
    return `Oracle Cloud event at ${item.pubDate}: "${item.title}" -- ${item.guid}`;
  }
};

async function connectIRCClient (connSpec) {
  if (connSpec.account && !connSpec.account.password && !connSpec.client_certificate) {
    const { password } = await inq.prompt({
      type: 'password',
      name: 'password',
      message: `Enter nickserv password for ${connSpec.nick}@${connSpec.host}`
    });

    connSpec.account.password = password;
  }

  if (connSpec.client_certificate && connSpec.client_certificate.fromFile) {
    const certFile = (await fs.promises.readFile(path.resolve(connSpec.client_certificate.fromFile))).toString('utf8');
    const boundaryRe = /-{5}(BEGIN|END)\s(PRIVATE\sKEY|CERTIFICATE)-{5}/g;
    const elems = {
      private_key: {},
      certificate: {}
    };

    for (const match of certFile.matchAll(boundaryRe)) {
      const [boundStr, state, type] = match;
      const typeXform = type.toLowerCase().replace(/\s+/g, '_');

      if (state === 'BEGIN') {
        if (type === 'PRIVATE KEY' && match.index !== 0) {
          throw new Error('pk start');
        }

        elems[typeXform].start = match.index;
      } else if (state === 'END') {
        if (elems[typeXform].start === undefined) {
          throw new Error('bad start!');
        }

        elems[typeXform] = certFile
          .substring(elems[typeXform].start, match.index + boundStr.length);
      }
    }

    if (Object.values(elems).some(x => !x)) {
      throw new Error('bad cert parse');
    }

    connSpec.client_certificate = elems;
  }

  const ircClient = new irc.Client();

  const regPromise = new Promise((resolve, reject) => {
    ircClient.on('registered', resolve.bind(null, ircClient));
  });

  ['debug', 'quit', 'reconnecting', 'close', 'socket close', 'kick', 'ban', 'join',
    'unknown command', 'channel info', 'topic', 'part', 'invited', 'tagmsg',
    'ctcp response', 'ctcp request', 'wallops', 'nick', 'nick in use', 'nick invalid',
    'whois', 'whowas', 'motd', 'info', 'help', 'mode']
    .forEach((ev) => {
      ircClient.on(ev, (x) => console.debug(`<IRC event "${ev}">`, x));
    });

  ircClient.connect(connSpec);
  return regPromise;
}

// Should return an list of strings, one for each line to be sent in reply
const commands = {
  uptime: async () => [`I've been running for ${fmtDuration(stats.upSince)} ` +
    `& have announced ${stats.announced} outage events during that time.`],
  feeds: async () => [
    `I'm following these ${Object.entries(config.feeds.rss).length} RSS feeds:`,
    ...Object.entries(config.feeds.rss).map(([prov, feedUrl]) => `${feedUrl} (${prov})`)
  ],
  help: async () => Object.keys(commands)
};

const privMsgOnlyCommands = ['help'];

async function commandHandler (client, msgObj) {
  const [trigger, command, ...args] = msgObj.message.trim().split(/\s+/g);

  if (trigger !== config.default.commandPrefix) {
    return;
  }

  const handler = commands[command];

  if (!handler) {
    return;
  }

  let privMsgReply = msgObj.target === config.irc.server.nick;
  let replyTarget = privMsgReply ? msgObj.nick : msgObj.target;
  const reply = await handler(...args);

  if (reply && reply.length) {
    if (!privMsgReply && privMsgOnlyCommands.includes(command)) {
      replyTarget = msgObj.nick;
      privMsgReply = true;
    }

    if (!privMsgReply) {
      reply[0] = `${msgObj.nick}: ${reply[0]}`;
    }

    console.log(`replying to ${command} with "${reply.join('|')}" on ${replyTarget}`);

    await floodProtect(config.default.commandFloodProtectWaitMs,
      reply.map((replyLine) => async () => client.say(replyTarget, replyLine)));
  } else {
    console.log(`executed command ${command} but it produced no reply`);
  }

  console.debug(command, msgObj, args, reply);
}

async function main () {
  logger('main');

  if (process.env.DEBUG) {
    logger.enableLevel('debug');
  }

  try {
    fs.mkdirSync(path.resolve(config.default.cacheDir));
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err;
    }
  }

  const ircClient = await connectIRCClient(config.irc.server);

  if (config.irc.forceAuthAfterReg) {
    await ircClient.say('NickServ', 'login', config.irc.server.account.password);
  }

  ircClient.on('message', commandHandler.bind(null, ircClient));
  await ircClient.join(config.irc.channel);

  process.on('SIGINT', async () => {
    await ircClient.part(config.irc.channel);
    setTimeout(() => process.exit(0), 1000);
  });

  const announceSayer = ircClient.say.bind(ircClient, config.irc.channel);

  for (const [svcName, feedUrl] of Object.entries(config.feeds.rss)) {
    const svcCheck = async (silentRunning = false) => {
      const parsed = await new RssParser().parseURL(feedUrl);
      const proced = serviceSpecificParsers[svcName](parsed);
      const nextCheck = Number(proced.next || config.default.pollingFrequencyMinutes);

      // we *do* want to await here, so that the time required to send all the messages
      // is accounted for in the next scheduled invocation (ensuring we never wrap back around on ourselves
      // still sending a bunch of messages from last invocation)
      await floodProtect(config.default.floodProtectWaitMs, proced.items.map((item) => {
        const fPath = path.resolve(path.join(config.default.cacheDir, svcName + '-' + item.outageBotId));
        try {
          fs.statSync(fPath);
          // if stat doesn't throw then fPath exists so we've already announced it; skip!
          // TODO: better checking to ensure nothing has changed?
          // TODO: should `touch` cache file to update mtime... once the items fall out of the RSS,
          // they won't get `touch`ed anymore and eventually we can use mtime to expire & remove them
          console.log(`Skipping already cached ${fPath}`);
        } catch (err) {
          // file doesn't exist meaning we've not announced this item yet: do so!
          if (err.code === 'ENOENT') {
            fs.promises.writeFile(fPath, JSON.stringify(item));
            console.log(`Caching new item ${fPath}`);

            return async () => {
              if (!silentRunning) {
                const rendered = serviceSpecificRenderers[svcName](item);
                console.log(`SAY'ing (svc: ${svcName}) "${rendered}"`);
                ++stats.announced;
                return announceSayer(rendered);
              }
            };
          }
        }

        return () => {}; // make es-lint happy...
      }));

      console.log(svcName, nextCheck, 'minutes', proced.items.length, 'items');
      setTimeout(svcCheck, nextCheck * 1000 * 60);
    };

    svcCheck(true);
  }
}

if (require.main === module) {
  main();
}
