const express = require('express');
const linebot = require('linebot');
const fs = require('fs');
const path = require('path');
var app = module.exports = express();

const bot = linebot({
    channelId: process.env.CHANNEL_ID,
    channelSecret: process.env.CHANNEL_SECRET,
    channelAccessToken: process.env.CHANNEL_TOKEN
});

const linebotParser = bot.parser();

// Redirect linebot webhook url to linebot parser
app.post('/linewebhook', linebotParser);

const join_message = '謝謝邀請我加入群組，讓我有機會服務大家～';

bot.on('join', function(event) {
    event.reply(join_message).then(function(data) {
        console.debug('Success to reply join event');
    }).catch(function(error) {
        console.error('Failed to reply join event', error);
    });
});

var enable_broadcast = true;
var photo_book_url = "https://photos.app.goo.gl/WjYaMDjvppjeodoG8";

var menu_pattern = new RegExp("服務(台|臺)");

var menu_message = {
    quickReply: {
        items: [
            {
                type: "action",
                action: {
                    type: "postback",
                    label: "開啟推播",
                    data: "enable_broadcast",
                    displayText: "開啟推播"
                }
            },
            {
                type: "action",
                action: {
                    type: "postback",
                    label: "關閉推播",
                    data: "disable_broadcast",
                    displayText: "關閉推播"
                }
            },
            {
                type: "action",
                action: {
                    type: "message",
                    label: "相簿連結",
                    text: photo_book_url,
                }
            }
        ]
    },
    type: "text",
    text: "您好，請問需要什麼服務?"
};

bot.on('postback', function(event) {
    if (event.postback.data === "enable_broadcast") {
        enable_broadcast = true;
    } else if (event.postback.data === "disable_broadcast") {
        enable_broadcast = false;
    } else {
        console.error('Unkown postback event data', event.postback);
    }
});

function handle_text_message(text) {
    if (menu_pattern.test(text)) {
        return menu_message;
    }

    return null;
}

function download_content(msg_id, path) {
    return bot.getMessageContent(msg_id)
        .then((buffer) => new Promise((resolve, reject) => {
            const writable = fs.createWriteStream(path);
            writable.write(buffer);
        }));
}

function upload_to_photo_book(type, msg_id) {
    // Download content from Line server
    const download_path = path.join(__dirname, `${type}-${msg_id}`);
    download_content(msg_id, download_path);

    // TODO: Upload content to Google Photo
}

bot.on('message', function(event) {
    var reply_message = null;

    switch (event.message.type) {
        case "text":
            reply_message = handle_text_message(event.message.text);
            break;
        case "image":
        case "video":
            if (event.message.contentProvider.type === "line") {
                upload_to_photo_book(event.message.type, event.message.id);
            }
            break;
        default:
            console.error('Unkown message type', event.message.type);
    }

    if (reply_message === null) {
        return;
    }

    event.reply(reply_message).then(function(data) {
        console.debug('Success to reply message event');
    }).catch(function(error) {
        console.error('Failed to reply message event', error);
    });
});

//Express API --------- App.get('path', callback function);
//routes HTTP GET requests to the specified path with the specified callback functions
app.get('/', function(request, response) {
    response.json({ message: 'response from node service!' });
});

app.post('/ajax', function(request, response) {
    response.send("response by ajax");
});
