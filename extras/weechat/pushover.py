# Pushover (https://pushover.net/) bridge for weechat.
#
# Sibling to notification_center.py. The two scripts are independent —
# notification_center is macOS-only (terminal-notifier), pushover is a remote
# HTTPS push so it works wherever weechat runs.
#
# Setup:
#   /set plugins.var.python.pushover.user_key   <your user key>
#   /set plugins.var.python.pushover.app_token  <your application token>
#
# By default fires on highlights + private messages in any channel.
# Override `channels` to restrict to a comma-separated allowlist (or `*` = all
# channel messages, like notification_center.py).
#
# HTTP is dispatched via weechat.hook_process_hashtable with a `url:` prefix,
# so the request runs in a forked child and weechat's main loop never blocks.

import datetime
import urllib.parse

import weechat


SCRIPT_NAME = 'pushover'
SCRIPT_AUTHOR = 'roost <noreply@anthropic.com>'
SCRIPT_VERSION = '0.1.0'
SCRIPT_LICENSE = 'MIT'
SCRIPT_DESC = 'Send weechat highlights and private messages to Pushover.'

weechat.register(SCRIPT_NAME, SCRIPT_AUTHOR, SCRIPT_VERSION, SCRIPT_LICENSE, SCRIPT_DESC, '', '')


DEFAULT_OPTIONS = {
	'user_key': '',
	'app_token': '',
	'channels': '',
	'priority': '0',
	'sound': '',
	'device': '',
	'max_body_chars': '140',
	'notify_self': 'off',
	'ignore_old_messages': 'off',
	'ignore_current_buffer_messages': 'off',
	'http_timeout_seconds': '10',
	'debug': 'off',
}

for key, val in DEFAULT_OPTIONS.items():
	if not weechat.config_is_set_plugin(key):
		weechat.config_set_plugin(key, val)

if not weechat.config_get_plugin('user_key') or not weechat.config_get_plugin('app_token'):
	weechat.prnt('', '[pushover] not configured — set plugins.var.python.pushover.user_key and .app_token')


def _opt(name):
	return weechat.config_get_plugin(name)

def _opt_int(name, default):
	try:
		return int(_opt(name))
	except ValueError:
		return default

def _truncate(s, n):
	return s if len(s) <= n else s[:n - 3].rstrip() + '...'

def _post_callback(data, command, return_code, out, err):
	if _opt('debug') == 'on':
		weechat.prnt('', '[pushover] rc=%d out=%r err=%r' % (return_code, out[:200], err[:200]))
	if return_code != 0 and return_code != weechat.WEECHAT_HOOK_PROCESS_RUNNING:
		weechat.prnt('', '[pushover] http rc=%d err=%s' % (return_code, err[:200] if err else ''))
	return weechat.WEECHAT_RC_OK

def _send(title, body):
	user_key = _opt('user_key')
	app_token = _opt('app_token')
	if not user_key or not app_token:
		return
	body = _truncate(body, _opt_int('max_body_chars', 140))
	form = {
		'token': app_token,
		'user': user_key,
		'title': title,
		'message': body,
	}
	priority = _opt('priority')
	if priority and priority != '0':
		form['priority'] = priority
	sound = _opt('sound')
	if sound:
		form['sound'] = sound
	device = _opt('device')
	if device:
		form['device'] = device
	weechat.hook_process_hashtable(
		'url:https://api.pushover.net/1/messages.json',
		{'postfields': urllib.parse.urlencode(form)},
		_opt_int('http_timeout_seconds', 10) * 1000,
		'_post_callback',
		'',
	)

weechat.hook_print('', 'irc_privmsg', '', 1, 'notify', '')

def notify(data, buffer, date, tags, displayed, highlight, prefix, message):
	if not _opt('user_key') or not _opt('app_token'):
		return weechat.WEECHAT_RC_OK

	own_nick = weechat.buffer_get_string(buffer, 'localvar_nick')
	if _opt('notify_self') != 'on' and (prefix == own_nick or prefix == ('@%s' % own_nick)):
		return weechat.WEECHAT_RC_OK

	if _opt('ignore_current_buffer_messages') == 'on' and buffer == weechat.current_buffer():
		return weechat.WEECHAT_RC_OK

	if _opt('ignore_old_messages') == 'on':
		message_time = datetime.datetime.utcfromtimestamp(int(date))
		if (datetime.datetime.utcnow() - message_time).seconds > 5:
			return weechat.WEECHAT_RC_OK

	channels_setting = _opt('channels').strip()
	notify_all = channels_setting == '*'
	allow_list = [] if (not channels_setting or notify_all) else [c.strip() for c in channels_setting.split(',')]
	channel = weechat.buffer_get_string(buffer, 'localvar_channel')

	is_private = 'irc_privmsg' in tags and 'notify_private' in tags
	is_highlight = bool(int(highlight))
	is_allowed_channel = notify_all or (channel and channel in allow_list)

	if is_private:
		_send('%s [private]' % prefix, message)
	elif is_highlight:
		_send('%s in %s' % (prefix, channel), message)
	elif is_allowed_channel:
		_send('%s in %s' % (prefix, channel), message)

	return weechat.WEECHAT_RC_OK
