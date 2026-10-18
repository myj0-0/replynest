---
sidebar_position: 6
title: Install ReplyNest (PWA)
description: Install the ReplyNest PWA on desktop, iPhone, iPad, and Android.
---

# Install ReplyNest (PWA)

The ReplyNest PWA is an installable customer-support app delivered securely by the browser, without an app store. It opens from your desktop, Start menu, dock, or mobile Home Screen and uses the same ReplyNest account and workspace.

## Before you install

- Installing the app never enables notifications automatically. Notification permission is requested only after you choose **Enable browser push**.
- Customer conversations, workspace pages, and API data are not stored in the offline cache. When offline, ReplyNest shows only a connection notice.
- Install only from `https://console.replynest.cn`.
- The console always provides an **Install app** action in the upper-right corner. After a workspace connects a valid channel, ReplyNest may also show the install benefit once; dismissing it prevents repeated prompts.

## Windows, macOS, and Linux

Use a current version of Chrome or Edge:

1. Open the [ReplyNest operations console](https://console.replynest.cn/login) and sign in.
2. Select **Install app** in the upper-right corner. If the browser opens its install dialog, confirm **Install**.
3. If no dialog appears, open the browser menu and choose **Install ReplyNest**, **Install app**, or **Create shortcut**.
4. Launch ReplyNest from your desktop, Start menu, dock, or app list.

Some browsers do not support native PWA installation. Use Chrome or Edge if the install action is unavailable.

## Android

1. Open the [ReplyNest operations console](https://console.replynest.cn/login) in Chrome.
2. Select **Install app** in ReplyNest, or open the Chrome menu.
3. Choose **Install app** or **Add to Home screen**, then confirm.
4. Open ReplyNest from the Home Screen. To receive background alerts, sign in, open **Notifications**, and explicitly enable browser push.

Menu names vary by device manufacturer. Allowing the browser to run in the background can prevent battery optimization from delaying notifications.

## iPhone and iPad

iOS does not allow a web page to open the system installer directly. Add ReplyNest with Safari:

1. Open the [ReplyNest operations console](https://console.replynest.cn/login) in Safari.
2. Tap the **Share** button in the Safari toolbar.
3. Scroll and choose **Add to Home Screen**.
4. Confirm the name and tap **Add**, then launch ReplyNest from the Home Screen.
5. To receive alerts, open the installed ReplyNest app, sign in, go to **Notifications**, and enable browser push.

If **Add to Home Screen** is missing, confirm that the page is open in Safari rather than an in-app browser such as WeChat.

## Updates and uninstalling

ReplyNest fetches updated app resources automatically while online. If an update is not visible, close the app completely and reopen it, or refresh once. Do not clear site data for normal updates: doing so signs you out and removes this device's push subscription.

Uninstall it like any other app: use the operating system or browser app-management page on desktop, or long-press the icon on mobile. Uninstalling the PWA does not delete your workspace account or cloud business data.

## FAQ

### Can agents reply while offline?

No. To avoid retaining customer information on shared devices and to keep conversation state accurate, reading and sending messages requires a network connection.

### Why are there no notifications after installation?

Installation and notifications are separate permissions. Open **Notifications**, select **Enable browser push**, and allow the permission in the browser or operating system. See [Notifications](notifications.md) for details.

### Can every agent install the app?

Yes. Every agent should use an individual ReplyNest account and install it on a controlled device. Do not share accounts or browser profiles.
