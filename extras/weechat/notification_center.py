# Adapted from https://github.com/sindresorhus/weechat-notification-center
#
# Differences from upstream:
#  - Loads `pync` (only used for its bundled terminal-notifier binary)
#    from a venv at ~/.config/weechat/venv so we don't pollute system python.
#  - `channels = *` notifies on every channel (upstream only takes an
#    explicit allowlist).
#  - Bypasses pync's Notifier.notify() and invokes the bundled
#    terminal-notifier directly. Two reasons:
#      (a) upstream passes `sound = lambda:_` as a "no sound" sentinel; pync
#          stringifies it into argv as `-sound <function ... at 0x...>`,
#          which terminal-notifier rejects.
#      (b) under weechat's plugin process tree, stdin isn't a TTY, so
#          terminal-notifier silently prefers stdin-piped input over the
#          `-message` argv flag. We pipe the body via stdin and drop
#          `-message` entirely; argv-supplied title/group/etc. are kept
#          ASCII-safe to avoid Cocoa's system-encoding argv decoding.
#  - `max_body_chars` truncates long bodies (default 140).

import os
import sys
import glob
import datetime
import subprocess
import unicodedata

_VENV_LIB = os.path.expanduser('~/.config/weechat/venv/lib')
for _sp in glob.glob(os.path.join(_VENV_LIB, 'python*/site-packages')):
	if _sp not in sys.path:
		sys.path.insert(0, _sp)

import weechat
import pync

TERMINAL_NOTIFIER = os.path.join(
	os.path.dirname(pync.__file__),
	'vendor', 'terminal-notifier-2.0.0',
	'terminal-notifier.app', 'Contents', 'MacOS', 'terminal-notifier',
)


SCRIPT_NAME = 'notification_center'
SCRIPT_AUTHOR = 'Sindre Sorhus <sindresorhus@gmail.com>'
SCRIPT_VERSION = '1.6.0+roost'
SCRIPT_LICENSE = 'MIT'
SCRIPT_DESC = 'Pass highlights, channel messages, and private messages to the macOS Notification Center'

weechat.register(SCRIPT_NAME, SCRIPT_AUTHOR, SCRIPT_VERSION, SCRIPT_LICENSE, SCRIPT_DESC, '', '')

WEECHAT_VERSION = weechat.info_get('version_number', '') or 0
if int(WEECHAT_VERSION) >= 0x03020000:
	WEECHAT_ICON = os.path.join(weechat.info_get('weechat_config_dir', ''), 'weechat.png')
else:
	WEECHAT_ICON = os.path.join(weechat.info_get('weechat_dir', ''), 'weechat.png')

DEFAULT_OPTIONS = {
	'enabled': 'on',
	'show_highlights': 'on',
	'show_private_message': 'on',
	'show_message_text': 'on',
	'sound': 'off',
	'sound_name': 'Pong',
	'activate_bundle_id': 'com.apple.Terminal',
	'ignore_old_messages': 'off',
	'ignore_current_buffer_messages': 'off',
	'channels': '',
	'tags': '',
	'max_body_chars': '140',
	'debug': 'off',
}

for key, val in DEFAULT_OPTIONS.items():
	if not weechat.config_is_set_plugin(key):
		weechat.config_set_plugin(key, val)

_PUNCT = {
	'—': '--', '–': '-',     # em-dash, en-dash
	'‘': "'",  '’': "'",     # curly singles
	'“': '"',  '”': '"',     # curly doubles
	'…': '...',                   # ellipsis
	' ': ' ',                     # nbsp
}

def _ascii_safe(s):
	for k, v in _PUNCT.items():
		s = s.replace(k, v)
	s = unicodedata.normalize('NFKD', s)
	return s.encode('ascii', errors='replace').decode('ascii')

def _truncate(s, n):
	return s if len(s) <= n else s[:n - 3].rstrip() + '...'

def _post(title, body, group, sound, activate, debug_on):
	title = _ascii_safe(title)
	group = _ascii_safe(group)
	body = _truncate(body, _max_body())
	cmd = [TERMINAL_NOTIFIER, '-title', title, '-group', group, '-appIcon', WEECHAT_ICON, '-activate', activate]
	if sound:
		cmd += ['-sound', sound]
	try:
		proc = subprocess.run(cmd, capture_output=True, text=True, timeout=5, input=body)
		if debug_on and proc.returncode != 0:
			weechat.prnt('', '[notif] rc=%d stdout=%r stderr=%r' % (proc.returncode, proc.stdout[:200], proc.stderr[:200]))
	except Exception as e:
		weechat.prnt('', '[notif] subprocess raised: %r' % e)

def _max_body():
	try:
		return int(weechat.config_get_plugin('max_body_chars'))
	except ValueError:
		return 140

weechat.hook_print('', 'irc_privmsg,' + weechat.config_get_plugin('tags'), '', 1, 'notify', '')

def notify(data, buffer, date, tags, displayed, highlight, prefix, message):
	if weechat.config_get_plugin('enabled') != 'on':
		return weechat.WEECHAT_RC_OK

	own_nick = weechat.buffer_get_string(buffer, 'localvar_nick')
	if prefix == own_nick or prefix == ('@%s' % own_nick):
		return weechat.WEECHAT_RC_OK

	if weechat.config_get_plugin('ignore_current_buffer_messages') == 'on' and buffer == weechat.current_buffer():
		return weechat.WEECHAT_RC_OK

	if weechat.config_get_plugin('ignore_old_messages') == 'on':
		message_time = datetime.datetime.utcfromtimestamp(int(date))
		now_time = datetime.datetime.utcnow()
		if (now_time - message_time).seconds > 5:
			return weechat.WEECHAT_RC_OK

	debug_on = weechat.config_get_plugin('debug') == 'on'
	sound = weechat.config_get_plugin('sound_name') if weechat.config_get_plugin('sound') == 'on' else None
	activate = weechat.config_get_plugin('activate_bundle_id')
	show_text = weechat.config_get_plugin('show_message_text') == 'on'

	channels_setting = weechat.config_get_plugin('channels').strip()
	notify_all = channels_setting == '*'
	channel_allow_list = [] if (not channels_setting or notify_all) else channels_setting.split(',')
	channel = weechat.buffer_get_string(buffer, 'localvar_channel')

	if notify_all or channel in channel_allow_list:
		title = '%s %s' % (prefix, channel)
		body = message if show_text else 'In %s by %s' % (channel, prefix)
		_post(title, body, 'weechat.%s.%s' % (channel, date), sound, activate, debug_on)
	elif weechat.config_get_plugin('show_highlights') == 'on' and int(highlight):
		title = '%s %s' % (prefix, channel) if show_text else 'Highlighted Message'
		body = message if show_text else 'In %s by %s' % (channel, prefix)
		_post(title, body, 'weechat.%s' % channel, sound, activate, debug_on)
	elif weechat.config_get_plugin('show_private_message') == 'on' and 'irc_privmsg' in tags and 'notify_private' in tags:
		title = '%s [private]' % prefix if show_text else 'Private Message'
		body = message if show_text else 'From %s' % prefix
		_post(title, body, 'weechat.%s' % prefix, sound, activate, debug_on)
	return weechat.WEECHAT_RC_OK
