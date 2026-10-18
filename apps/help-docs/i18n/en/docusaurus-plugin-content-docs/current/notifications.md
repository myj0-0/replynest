---
sidebar_position: 5
title: Notifications
---

# Notifications

Notification Center alerts the team; Messages and Campaigns is customer-facing operations, not the same permission. Shared accounts do not support marketing broadcasts.

Set channel, severity, quiet hours, timezone and escalation in [Notifications](https://console.replynest.cn/notifications). Browser push requires your click and browser permission; iOS/iPadOS first installs to the home screen. In-app notifications remain on. WeCom application notifications are unavailable, unlike group robots.

External HTTPS targets support Feishu, DingTalk, WeCom robots and custom webhooks. Optional HMAC is for custom targets; URLs with tokens are credentials. DingTalk messages contain `ReplyNest`. Preview is off by default; enabling it can transmit up to 120 customer-message characters to your third party, so verify recipients and privacy first.

ReplyNest supports browser push, Feishu, DingTalk, WeCom, and custom webhooks for unattended-conversation alerts.

Start with delayed alerts instead of notifying on every message, and periodically test each destination.
