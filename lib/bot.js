import _ from 'lodash';
import irc from 'irc';
import logger from 'winston';
import discord from 'discord.js';
import { ConfigurationError } from './errors';
import { formatFromDiscordToIRC, formatFromIRCToDiscord } from './formatting';

const REQUIRED_FIELDS = ['ircNickname', 'ircServer', 'ircChannel', 'discordId', 'discordToken'];
const NICK_COLORS = ['light_blue', 'dark_blue', 'light_red', 'dark_red', 'light_green',
  'dark_green', 'magenta', 'light_magenta', 'orange', 'yellow', 'cyan', 'light_cyan'];
const patternMatch = /{\$(.+?)}/g;

/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options - ircNickname, ircServer, ircChannel, discordId, discordToken
 */
class Bot {
  constructor(options) {
    REQUIRED_FIELDS.forEach((field) => {
      if (!options[field]) {
        throw new ConfigurationError(`Missing configuration field ${field}`);
      }
    });

    this.ircNickname = options.ircNickname;
    this.ircServer = options.ircServer;
    this.ircChannel = options.ircChannel;
    this.ircOptions = options.ircOptions;
    this.discordId = options.discordId;
    this.discordToken = options.discordToken;
    this.discordClient = new discord.WebhookClient(this.discordId, this.discordToken, {});

    this.commandCharacters = options.commandCharacters || [];
    this.channels = _.values(options.channelMapping);
    this.ircStatusNotices = options.ircStatusNotices;
    this.announceSelfJoin = options.announceSelfJoin;

    this.autoSendCommands = options.autoSendCommands || [];

    this.channelUsers = {};
  }

  connect() {
    logger.debug('Connecting to IRC and Discord');

    const ircOptions = {
      userName: this.ircNickname,
      realName: this.ircNickname,
      channels: [this.ircChannel],
      floodProtection: true,
      floodProtectionDelay: 500,
      retryCount: 10,
      ...this.ircOptions
    };

    this.ircClient = new irc.Client(this.ircServer, this.ircNickname, ircOptions);
    this.attachListeners();
  }

  attachListeners() {
    this.ircClient.on('registered', (message) => {
      logger.info('Connected to IRC');
      logger.debug('Registered event: ', message);
      this.autoSendCommands.forEach((element) => {
        this.ircClient.send(...element);
      });
    });

    this.ircClient.on('error', (error) => {
      logger.error('Received error event from IRC', error);
    });

    this.ircClient.on('message', this.sendToDiscord.bind(this));

    this.ircClient.on('notice', (author, to, text) => {
      this.sendToDiscord(author, to, `*${text}*`);
    });

    this.ircClient.on('join', (channelName, nick) => {
      const channel = channelName.toLowerCase();
      if (channel !== this.ircChannel) return;

      logger.debug('Received join:', channelName, nick);
      if (!this.ircStatusNotices) return;
      if (nick === this.ircNickname && !this.announceSelfJoin) return;

      // self-join is announced before names (which includes own nick)
      // so don't add nick to channelUsers
      if (nick !== this.ircNickname) this.channelUsers[channel].add(nick);
      this.sendExactToDiscord(channel, `*${nick}* has joined the channel`);
    });

    this.ircClient.on('part', (channelName, nick, reason) => {
      const channel = channelName.toLowerCase();
      if (channel !== this.ircChannel) return;

      logger.debug('Received part:', channelName, nick, reason);
      if (!this.ircStatusNotices) return;

      // remove list of users when no longer in channel (as it will become out of date)
      if (nick === this.ircNickname) {
        logger.debug('Deleting channelUsers as bot parted:', channel);
        delete this.channelUsers[channel];
        return;
      }
      if (this.channelUsers[channel]) {
        this.channelUsers[channel].delete(nick);
      } else {
        logger.warn(`No channelUsers found for ${channel} when ${nick} parted.`);
      }
      this.sendExactToDiscord(channel, `*${nick}* has left the channel (${reason})`);
    });

    this.ircClient.on('quit', (nick, reason, channels) => {
      logger.debug('Received quit:', nick, channels);
      if (!this.ircStatusNotices || nick === this.ircNickname) return;
      channels.forEach((channelName) => {
        const channel = channelName.toLowerCase();
        if (!this.channelUsers[channel]) {
          logger.warn(`No channelUsers found for ${channel} when ${nick} quit, ignoring.`);
          return;
        }
        if (!this.channelUsers[channel].delete(nick)) return;
        this.sendExactToDiscord(channel, `*${nick}* has quit (${reason})`);
      });
    });

    this.ircClient.on('names', (channelName, nicks) => {
      const channel = channelName.toLowerCase();
      if (channel !== this.ircChannel) return;

      logger.debug('Received names:', channelName, nicks);
      if (!this.ircStatusNotices) return;

      this.channelUsers[channel] = new Set(Object.keys(nicks));
    });

    this.ircClient.on('action', (author, to, text) => {
      this.sendToDiscord(author, to, `_${text}_`);
    });

    this.ircClient.on('invite', (channel, from) => {
      if (channel !== this.ircChannel) return;

      logger.debug('Received invite:', channel, from);
      if (!this.invertedMapping[channel]) {
        logger.debug('Channel not found in config, not joining:', channel);
      } else {
        this.ircClient.join(channel);
        logger.debug('Joining channel:', channel);
      }
    });

    if (logger.level === 'debug') {
      this.discord.on('debug', (message) => {
        logger.debug('Received debug event from Discord', message);
      });
    }
  }

  sendToDiscord(author, channel, text) {
    if (channel !== this.ircChannel) return;

    // Convert text formatting (bold, italics, underscore)
    const content = formatFromIRCToDiscord(text);

    logger.debug('Sending message to Discord', content, channel);
    this.discordClient.sendMessage(content, {
      username: author
    });
  }

  /* Sends a message to Discord exactly as it appears */
  sendExactToDiscord(channel, text) {
    if (channel !== this.ircChannel) return;

    logger.debug('Sending special message to Discord', text, channel);
    this.discordClient.sendMessage(text, {});
  }
}

export default Bot;
