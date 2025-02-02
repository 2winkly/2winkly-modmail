/* eslint-disable no-redeclare */
import { type GuildSettings, PrismaClient, type Thread } from '@prisma/client';
import type {
	AnyThreadChannel,
	APIEmbed,
	ContextMenuCommandInteraction,
	ForumChannel,
	GuildForumTag,
	GuildForumThreadCreateOptions,
	InteractionResponse,
	JSONEncodable,
	MessageCreateOptions,
	TextChannel,
	ThreadChannel,
} from 'discord.js';
import {
	ComponentType,
	ChannelType,
	SelectMenuBuilder,
	ActionRowBuilder,
	SelectMenuOptionBuilder,
	type ChatInputCommandInteraction,
	Colors,
	EmbedBuilder,
	time,
	TimestampStyles,
	type UserContextMenuCommandInteraction,
	Message,
	type Guild,
	type GuildMember,
	Client,
} from 'discord.js';
import i18next from 'i18next';
import { container } from 'tsyringe';
import { logger } from '#util/logger';
import { getSortedMemberRolesString } from './getSortedMemberRoles';
import { Env } from '#struct/Env';
const env = container.resolve(Env);

const promptTags = async (
	input: ChatInputCommandInteraction | ContextMenuCommandInteraction | Message,
	tags: GuildForumTag[],
): Promise<GuildForumTag | null> => {
	const actionRow = new ActionRowBuilder<SelectMenuBuilder>().setComponents(
		new SelectMenuBuilder().setCustomId('user-tag-selector').addOptions(
			[...tags.values()].map((tag) => {
				const selectMenuOption = new SelectMenuOptionBuilder().setLabel(tag.name).setValue(tag.id);
				if (tag.emoji) {
					selectMenuOption.setEmoji({ name: tag.emoji.name ?? undefined, id: tag.emoji.id ?? undefined });
				}

				return selectMenuOption;
			}),
		),
	);

	const options = {
		content: 'Please select one of the options below so that we can best assist you.',
		components: [actionRow],
	};

	const prompt = await input.channel?.send(options);

	if (!prompt) {
		return null;
	}

	const selectMenu = await prompt.awaitMessageComponent({ idle: 30_000, componentType: ComponentType.SelectMenu }).catch(() => null);

	if (!selectMenu) {
		await prompt.edit({
			content: 'Timed out...',
			embeds: [],
			components: [],
		});
		return null;
	}

	await prompt.delete();

	return tags.find((tag) => tag.id === selectMenu.values.at(0)) ?? null;
};

export type MessageOpenThreadReturn = {
	existing: boolean;
	member: GuildMember;
	settings: GuildSettings;
	thread: Thread;
	threadChannel: ThreadChannel;
};

export function openThread(
	input: ChatInputCommandInteraction<'cached'> | UserContextMenuCommandInteraction<'cached'>,
): Promise<Message>;

export function openThread(input: Message<false>, definedGuild: Guild): Promise<MessageOpenThreadReturn>;

export async function openThread(
	input: ChatInputCommandInteraction<'cached'> | Message<false> | UserContextMenuCommandInteraction<'cached'>,
	definedGuild?: Guild,
): Promise<Message | InteractionResponse | MessageOpenThreadReturn> {
	const prisma = container.resolve(PrismaClient);
	const client = container.resolve(Client);
	const isMessage = input instanceof Message;
	const guild = isMessage ? definedGuild! : input.guild;

	const send = isMessage
		? async (key: string) => input.channel.send(i18next.t(key, { lng: guild.preferredLocale }))
		: async (key: string) => input.reply(i18next.t(key, { lng: input.locale }));

	const sendEmbed = isMessage
		? async (embed: APIEmbed | JSONEncodable<APIEmbed>) => input.channel.send({embeds: [embed]})
		: async (embed: APIEmbed | JSONEncodable<APIEmbed>) => input.reply({embeds: [embed]});

	const user =
		'targetUser' in input ? input.targetUser : isMessage ? input.author : input.options.getUser('user', true);

	const settings = await prisma.guildSettings.findFirst({ where: { guildId: guild.id } });
	if (!settings?.modmailChannelId || !guild.channels.cache.has(settings.modmailChannelId)) {
		return send('common.errors.thread_creation');
	}

	const modmail = guild.channels.cache.get(settings.modmailChannelId) as ForumChannel | TextChannel;
	const existingThread = await prisma.thread.findFirst({
		where: {
			guildId: guild.id,
			userId: user.id,
			closedById: null,
		},
	});

	const member = await guild.members.fetch(user).catch(() => null);
	if (!member) {
		return send('common.errors.no_member');
	}

	if (existingThread) {
		// eslint-disable-next-line no-shadow
		const threadChannel = (await client.channels
			.fetch(existingThread.channelId)
			.catch(() => null)) as ThreadChannel | null;

		if (threadChannel) {
			if (isMessage) {
				return {
					thread: existingThread,
					threadChannel,
					member,
					settings,
					existing: true,
				};
			}

			return send('common.errors.thread_exists');
		}

		await prisma.thread.delete({ where: { threadId: existingThread.threadId } });
	}

	const pastModmails = await prisma.thread.findMany({
		where: {
			guildId: guild.id,
			userId: member.id,
		},
	});

	if (!isMessage) {
		await input.deferReply();
	}

	const embed = new EmbedBuilder()
		.setFooter({
			text: `${member.user.tag} (${member.user.id})`,
			iconURL: member.user.displayAvatarURL(),
		})
		.setColor(Colors.NotQuiteBlack)
		.setFields(
			{
				name: i18next.t('thread.start.embed.fields.account_created'),
				value: time(member.user.createdAt, TimestampStyles.LongDate),
				inline: true,
			},
			{
				name: i18next.t('thread.start.embed.fields.joined_server'),
				value: time(member.joinedAt!, TimestampStyles.LongDate),
				inline: true,
			},
			{
				name: i18next.t('thread.start.embed.fields.past_modmails'),
				value: pastModmails.length.toString(),
				inline: true,
			},
			{
				name: i18next.t('thread.start.embed.fields.opened_by'),
				value: isMessage ? input.author.toString() : input.user.toString(),
				inline: true,
			},
			{
				name: i18next.t('thread.start.embed.fields.roles'),
				value: getSortedMemberRolesString(member),
				inline: true,
			},
		);

	if (member.nickname) {
		embed.setAuthor({
			name: member.nickname,
			iconURL: member.displayAvatarURL(),
		});
	}


	let startMessageOptions: GuildForumThreadCreateOptions | MessageCreateOptions;
	if (modmail.type === ChannelType.GuildForum) {
		const tags = modmail.availableTags.filter((tag) => !tag.moderated);
		let tag: GuildForumTag | null = null;
		if (tags.length > 0) {
			tag = await promptTags(input, tags);
		}
		if (!tag) {
			return send('**Error:** You did not select a category from the dropdown, so your message was not sent. Send a new message to continue using Modmail.');
		}

		const generateFarewellEmbed = (description: string) =>  new EmbedBuilder()
		.setAuthor({
			name: `${guild.name}`,
			iconURL: guild.iconURL() ?? undefined,
		})
		.setDescription(description)
		.setColor(parseInt("2b2d31", 16));
		
		const snippets = await prisma.snippet.findMany({ where: { guildId: guild.id } });
		const matchingSnippet = snippets.find(s=>s.name.replace(/-/g, ` `)===tag?.name?.toLowerCase().replace(/[^\w\d]/g, ` `));

		if (matchingSnippet !== undefined) {
			const errorEmbed = generateFarewellEmbed(matchingSnippet.content);
			const logChannel = await guild.channels.fetch(env.logChannelId);
			if (logChannel && logChannel.type === ChannelType.GuildText){
				logChannel.send({embeds: [
					generateFarewellEmbed(matchingSnippet.content).setTitle('User Redirected to Support')
						.addFields({
							name: 'Dropdown Option',
							value: tag.name.toLowerCase().split(' ').map((s) => s.charAt(0).toUpperCase() + s.substring(1)).join(' '),
							},
							{
								name: 'User',
								value: user.toString()
							})
						]}
					).catch(() => logger.warn(`Error Posting to Log Channel (${logChannel.id})`));
			}
			return sendEmbed(errorEmbed);
		}

		let name = `${member.user.username}-${member.user.discriminator}`;
		if (input instanceof Message) // max length 100
			name = input.content.substr(0, 97).trim() + (input.content.length > 97 ? '...' : '');

		startMessageOptions = {
			name: name,
			message: { embeds: [embed] },
			appliedTags: tag ? [tag.id] : [],
		};
	} else {
		startMessageOptions = { embeds: [embed] };
	}

	if (isMessage) {
		embed.spliceFields(3, 1);

		let alert: string | null = null;
		if (settings.alertRoleId) {
			const role = guild.roles.cache.get(settings.alertRoleId);
			if (role) {
				alert = `Alert: ${role.toString()} <@&1207992209673293844>`; // @TODO Remove this maybe sometime? Trial moderator tag poorly hardcoded in lol
			}
		} else {
			const alerts = await prisma.threadOpenAlert.findMany({ where: { guildId: guild.id } });
			alert = alerts.length ? `Alerts: ${alerts.map((a) => `<@${a.userId}>`).join(' ')}` : null;
		}

		if (modmail.type === ChannelType.GuildForum) {
			// @ts-expect-error - I don't know what drugs this thing is taking, but it's acting like content isn't supposed to be here
			startMessageOptions.message.content = `${member.toString()}${alert ? `\n${alert}` : ''}`;
		} else {
			(startMessageOptions as MessageCreateOptions).content = `${member.toString()}${alert ? `\n${alert}` : ''}`;
		}
	} else if (modmail.type === ChannelType.GuildForum) {
		// @ts-expect-error - I don't know what drugs this thing is taking, but it's acting like content isn't supposed to be here
		startMessageOptions.message.content = member.toString();
	} else {
		(startMessageOptions as MessageCreateOptions).content = member.toString();
	}

	let threadChannel: AnyThreadChannel | ThreadChannel;
	if (modmail.type === ChannelType.GuildForum) {
		threadChannel = await modmail.threads.create(startMessageOptions as GuildForumThreadCreateOptions);
	} else {
		const startMessage = await modmail.send(startMessageOptions as MessageCreateOptions);

		threadChannel = await startMessage.startThread({
			name: `${member.user.username}-${member.user.discriminator}`,
		});
	}

	const thread = await prisma.thread.create({
		data: {
			guildId: guild.id,
			channelId: threadChannel.id,
			userId: member.id,
			createdById: user.id,
		},
	});

	if (isMessage) {
		return {
			thread,
			threadChannel,
			member,
			settings,
			existing: false,
		};
	}

	return input.editReply(i18next.t('common.success.opened_thread', { lng: input.locale }));
}
