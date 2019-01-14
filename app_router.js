const semaphore = require('await-semaphore');

const express = require('express');
const linebot = require('linebot');
const {google} = require('googleapis');
const fs = require('fs');
const streamifier = require('streamifier');
const path = require('path');
const request = require('request-promise');
const winston = require('winston');
var app = module.exports = express();


// Console transport for winton.
const consoleTransport = new winston.transports.Console({
    prettyPrint: JSON.stringify
});

// Set up winston logging.
const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [
    consoleTransport
  ]
});

// Log Levels:
// error: 0, warn: 1, info: 2, verbose: 3, debug: 4, silly: 5
if (process.env.LOG_LEVEL) {
    logger.level = process.env.LOG_LEVEL;
} else {
    logger.level = 'warn';
}

const download_path = path.join(__dirname, 'download');
fs.mkdir(download_path, function(err) {
    // Ignore file existed error
    if (err && err.errno != -17) {
        logger.error("Failed to creating download folder", err);
    }
});

const google_auth_client = new google.auth.OAuth2(
    process.env.OAUTH_CLIENT_ID,
    process.env.OAUTH_CLIENT_SECRET,
    process.env.OAUTH_REDIRECT_URL
);

google_auth_client.setCredentials({
    "refresh_token": process.env.OAUTH_REFRESH_TOKEN
});

async function get_access_token() {
    var tokens = await google_auth_client.getAccessToken();
    return tokens.token;
}

// generate a url that asks permissions for Photo Library sharing scopes
const scopes = [
    'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
    'https://www.googleapis.com/auth/photoslibrary.sharing'
];

const auth_url = google_auth_client.generateAuthUrl({
    // 'online' (default) or 'offline' (gets refresh_token)
    access_type: 'offline',

    // If you only need one scope you can pass it as a string
    scope: scopes.join(' ')
});

app.get('/auth/google', function(request, response) {
    response.redirect(auth_url);
});

app.get('/auth/google/callback', function(request, response) {
    if (request.query && request.query.error) {
        logger.error("Authentication failed", request.query.error);
        response.send("Authentication Failed");
    } else {
        var code = request.query.code;
        google_auth_client.getToken(code, function(err, tokens) {
            if (err) {
                logger.error("Failed to get tokens from Authentication Server", err);
                response.send("Failed to get tokens from Authentication Server");
            } else {
                logger.info("Get tokens", tokens);

                google_auth_client.setCredentials(tokens);
                response.send("Authentication Success!");
            }
        });
    }
});

// TODO(james): retrive album info from database
const default_album_id = "ALv8aGRWyA0U11qF7_cz4OQb0K529I4tgW2Xxp2JMm93HHulBVljmGxofo-S4Ipxs5xI3Orr6Pvx";
const default_album_shared_link = "https://photos.app.goo.gl/pdjhnP3Nqp5bK8Vw7";

app.get('/albums', async(req, res) => {
    const token = await get_access_token();

    const data = await get_shared_albums(token);
    if (data.error !== null) {
        res.status(500).send(data.error);
    } else {
      res.status(200).send(data.albums);
    }
});

app.post('/album/:title', async(req, res) => {
    const token = await get_access_token();

    const error = await create_shared_album(token, req.params.title);
    if (error) {
      res.status(500).send(error);
    } else {
      res.status(200).send('Create album success');
    }
});

app.post('/uploadAll', async(req, res) => {
    var files = fs.readdirSync(download_path);
    for (const file of files) {
        var item = {
            "name": file,
            "album_id": default_album_id,
            "stream": fs.createReadStream(path.join(download_path, file))
        };

        enqueue_upload_item(item);
    };

    logger.info(`Upload media item test done`);
    res.status(200).send(`Upload media item test done`);
});

async function create_shared_album(token, title) {
    let error = null;
    let result = null;

    try {
        result = await request.post('https://photoslibrary.googleapis.com/v1/albums', {
            headers: {'Content-Type': 'application/json'},
            json: true,
            auth: {'bearer': token},
            body: {
              "album": {
                "title": title
              }
            }
        });

        result = await request.post(`https://photoslibrary.googleapis.com/v1/albums/${result.id}:share`, {
            headers: {'Content-Type': 'application/json'},
            json: true,
            auth: {'bearer': token},
            body: {
                "sharedAlbumOptions": {
                  "isCollaborative": true,
                  "isCommentable": true
                }
            }
        });

        logger.debug('Response of sharing album:', result);
    } catch(err) {
        if (err.error.error) {
            error = {"code": err.error.error.code, "message": err.error.error.status};
        } else {
            error = {"name": err.name, "message": err.message};
        }
        logger.error(`Failed to create shared album`, error);
    }

    return error;
}

// Returns a list of all albums owner by the logged in user from the Library
// API.
async function get_shared_albums(authToken) {
    let albums = [];
    let nextPageToken = null;
    let error = null;
    let parameters = {
      pageSize: 10,
      excludeNonAppCreatedData: false
    };

    try {
        // Loop while there is a nextpageToken property in the response until all
        // albums have been listed.
        do {
            logger.debug(`Loading shared albums. Received so far: ${albums.length}`);
            // Make a GET request to load the albums with optional parameters (the
            // pageToken if set).
            const result = await request.get('https://photoslibrary.googleapis.com/v1/sharedAlbums', {
                headers: {'Content-Type': 'application/json'},
                qs: parameters,
                json: true,
                auth: {'bearer': authToken},
            });

            logger.debug('Response:', result);

            if (result && result.sharedAlbums) {
                logger.debug(`Number of albums received: ${result.sharedAlbums.length}`);
                // Parse albums and add them to the list, skipping empty entries.
                const items = result.sharedAlbums.filter(x => !!x);

                albums = albums.concat(items);
            }
            parameters.pageToken = result.nextPageToken;
            // Loop until all albums have been listed and no new nextPageToken is
            // returned.
        } while (parameters.pageToken);

        logger.info('Albums loaded.');
    } catch (err) {
        error = {name: err.name, message: err.message};
        logger.error(`Failed to get album list: ${error.message}`);
    }

    return {albums, error};
}

// max retry count for upload or download items
var max_retry = 3;

// upload_item format: {
//     "name": ...,
//     "album_id": ...,
//     "stream": ...,
//     "retry_count": ...,
//     "token": ...
// }
var upload_item_list = []; // items to be upload to google
var upload_item_history = []; //
var history_index = 0;
var max_history_entry = 100;

function save_to_upload_history(upload_item, token) {
    upload_item.token = token;
    upload_item_history[history_index] = upload_item;
    history_index = (history_index + 1) % max_history_entry;
}

function enqueue_upload_item(upload_item) {
    if (!('retry_count' in upload_item)) {
        upload_item.retry_count = 0;
    }
    upload_item_list.push(upload_item);
}

function dequeue_upload_item() {
    return upload_item_list.shift();
}

// For 429 errors, the client may retry with minimum 30 s delay
// reference: https://developers.google.com/photos/library/guides/best-practices
const task_polling = 30; // seconds
setInterval(upload_items, task_polling * 1000);

const max_upload_items = 30; // max number of items handled by upload task per polling interval
var in_progress_upload_items = 0;
var mtx_lock = new semaphore.Semaphore(1); // execute only one task at a time(upload_item or add_item)

async function upload_items() {
    var i = 0;
    var release = await mtx_lock.acquire();

    do {
        let item = dequeue_upload_item();
        if (!item) {
            break;
        }
        upload_media_item(item);
        i++;
        in_progress_upload_items++;
    } while(i < max_upload_items);

    while(in_progress_upload_items) {
        await sleep(in_progress_upload_items * 1.5);
    }

    await add_items();

    release();
}

// google allows add 50 items to a album in a REST API call
const max_upload_tokens = 50;

async function add_items() {
    var album_list = Object.keys(upload_token_map);

    for (const album_id of album_list) {
        let num_tokens = upload_token_map[album_id].length;

        if (num_tokens == 0) {
            continue;
        }
        if (num_tokens > max_upload_tokens) {
            num_tokens = max_upload_tokens;
        }

        let upload_token_list = upload_token_map[album_id].splice(0, num_tokens);
        await add_item_to_album(album_id, upload_token_list);
    };
}

function save_to_disk(item) {
    logger.error(`Give up retry and save item to disk: ${item.name}`);

    return new Promise((resolve, reject) => {
        const writable = fs.createWriteStream(path.join(download_path, item.name));
        item.stream.pipe(writable);
        item.stream.on('end', () => resolve(item.name));
        item.stream.on('error', reject);
    });
}

// (key, value) = (album_id, upload_token_array)
var upload_token_map = {}; // items to be added to album
var sem_lock = new semaphore.Semaphore(5); // limit number of concurrent upload requests

async function upload_media_item(upload_item) {
    let error = null;
    const access_token = await get_access_token();

    var release = await sem_lock.acquire();
    try {
        await sleep_random(3,5); // add delay to avoid that Google complains abuse the service
        let upload_token = await request.post('https://photoslibrary.googleapis.com/v1/uploads', {
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Goog-Upload-File-Name': upload_item.name,
              'X-Goog-Upload-Protocol': 'raw'
            },
            json: false,
            auth: {'bearer': access_token},
            body: upload_item.stream
        });

        let album_id = upload_item.album_id;

        if (!(album_id in upload_token_map)) {
            upload_token_map[album_id] = [];
        }
        upload_token_map[album_id].push(upload_token);

        save_to_upload_history(upload_item, upload_token);

        logger.info(`Upload media item success: ${upload_item.name}`);
    } catch(err) {
        if (upload_item.retry_count < max_retry) {
            upload_item.retry_count++;
            enqueue_upload_item(upload_item);
        } else {
            save_to_disk(upload_item).then((filename) => {
                logger.info(`file saved to disk: ${filename}`);
            });
        }

        if (err.error.error) {
            error = {"code": err.error.error.code, "message": err.error.error.status};
        } else {
            error = {"name": err.name, "message": err.message};
        }
        logger.error(`Failed to upload media item: ${upload_item.name}`, error);
    }

    release();
    in_progress_upload_items--;

    return error;
}

async function add_item_to_album(album_id, upload_token_list) {
    let error = null;
    const access_token = await get_access_token();

    try {
        let media_items = [];
        for (const token of upload_token_list) {
            media_items.push({
                "description": "",
                "simpleMediaItem": {
                    "uploadToken": token
                }
            });
        }

        logger.info(`start adding (${media_items.length}) items to album: ${album_id}`);

        await sleep_random(3,5); // add delay to avoid that Google complains abuse the service
        let result = await request.post(`https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate`, {
            headers: {'Content-Type': 'application/json'},
            json: true,
            auth: {'bearer': access_token},
            body: {
                "albumId": album_id,
                "newMediaItems": media_items
            }
        });

        let status_codes = result["newMediaItemResults"].map(item => item.status.code);
        let fail_count = 0;
        let retry_items = 0;
        let i = 0;
        for (i = 0; i < status_codes.length; i++) {
            // only retry the items with HTTP error: 5xx
            // reference: https://github.com/googleapis/googleapis/blob/master/google/rpc/code.proto
            if (status_codes[i] && status_codes[i] >= 13) {
                upload_token_map[album_id].push(upload_token_list[i]);
                retry_items++;
            } else if (status_codes[i]) {
                for (const item of upload_item_history) {
                    if (item.token === upload_token_list[i]) {
                        save_to_disk(item).then((filename) => {
                            logger.info(`file saved to disk: ${filename}`);
                        });;
                    }
                }
                fail_count++;
            }
        }
        logger.info(`total ${status_codes.length} items added, will retry: ${retry_items}, failed: ${fail_count}, status:`, status_codes);
    } catch(err) {
        upload_token_map[album_id] = upload_token_map[album_id].concat(upload_token_list); // add back to map for retry

        if (err.error.error) {
            error = {"code": err.error.error.code, "message": err.error.error.status};
        } else {
            error = {"name": err.name, "message": err.message};
        }
        logger.error(`Failed to add media items to album: ${album_id}`);
    }

    return error;
}

const bot = linebot({
    channelId: process.env.CHANNEL_ID,
    channelSecret: process.env.CHANNEL_SECRET,
    channelAccessToken: process.env.CHANNEL_TOKEN
});


function sleep_random(min, max){
    return new Promise(resolve => {
        var seconds = Math.floor(Math.random() * (max-min)) + min;
        setTimeout(resolve, seconds * 1000);
    });
}

function sleep(seconds){
    return new Promise(resolve => {
        setTimeout(resolve, seconds * 1000);
    });
}

// content_msg = {
//     "id": ...,
//     "type": ...,
//     "source": {
//         "type": ...,
//         "userId" | "groupId" | "roomId": ...
//     },
//     "retry_count": ...
// };
// reference: https://developers.line.biz/en/reference/messaging-api/#wh-image
//            https://developers.line.biz/en/reference/messaging-api/#common-properties
var content_msg_list = [];
const max_download_items = 15; // max number of items handled by download task per polling interval

function enqueue_content_msg(msg) {
    if (!('retry_count' in msg)) {
        msg.retry_count = 0;
    }
    content_msg_list.push(msg);
}

function dequeue_content_msg() {
    return content_msg_list.shift();
}

setInterval(download_contents, task_polling * 1000);

function download_contents() {
    var i = 0;
    do {
        let content_msg = dequeue_content_msg();
        if (!content_msg) {
            break;
        }

        download_content(content_msg);
        i++;
    } while(i < max_download_items);
}

async function query_album_id(source) {
    // TODO(james): query album id from database according to group ID or room ID
    return default_album_id;
}

var download_lock = new semaphore.Semaphore(5); // limit concurrent downloads

async function download_content(content_msg) {
    var album_id = await query_album_id(content_msg.source);
    var msg_type = content_msg.type;
    var msg_id = content_msg.id;

    var release = await download_lock.acquire();
    try {
        const buffer = await bot.getMessageContent(msg_id);
        if (buffer && (buffer.length > 256)) {
            // Upload content to Google Photo
            var upload_item = {
                "name": `${msg_type}-${msg_id}`,
                "album_id" : album_id,
                "stream": streamifier.createReadStream(buffer)
            };

            enqueue_upload_item(upload_item);
            logger.info(`Download media content success: ${msg_type}-${msg_id} (size: ${buffer.length})`);
        } else {
            let need_retry = true;
            if (buffer) {
                try {
                    // if buffer content is error message, we should retry downloading again later
                    JSON.parse(buffer.toString());
                    logger.warn(`Get error message when downloading: ${msg_type}-${msg_id}: ${buffer.toString()}`);
                } catch (err) {
                    // buffer is not a JSON object, we should treat it as normal content
                    need_retry = false;
                    enqueue_upload_item(upload_item);
                    logger.info(`Download media content success: ${msg_type}-${msg_id} (size: ${buffer.length})`);
                }
            }

            if (need_retry) {
                if (content_msg.retry_count < max_retry) {
                    content_msg.retry_count++;
                    enqueue_content_msg(content_msg);
                    logger.warn(`Failed to download content, will retry again: ${msg_type}-${msg_id}`);
                } else {
                    logger.error(`Failed to download content, stop retry: ${msg_type}-${msg_id}`);
                }
            }
        }
    } catch(err) {
        logger.error("Failed to download content due to exception:", err);
    }

    release();
}

const linebotParser = bot.parser();

// Redirect linebot webhook url to linebot parser
app.post('/linewebhook', linebotParser);

const join_message = '謝謝邀請我加入群組，讓我有機會服務大家～';

bot.on('join', function(event) {
    event.reply(join_message).then(function(data) {
        logger.debug('Success to reply join event');
    }).catch(function(error) {
        logger.error('Failed to reply join event', error);
    });
});

var enable_broadcast = true;

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
                    text: default_album_shared_link,
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
        logger.error('Unkown postback event data', event.postback);
    }
});

function handle_text_message(text) {
    if (menu_pattern.test(text)) {
        return menu_message;
    }

    return null;
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
                let content_msg = {
                    "id": event.message.id,
                    "type": event.message.type,
                    "source": event.source
                };
                enqueue_content_msg(content_msg);
            }
            break;
        default:
            logger.error('Unkown message type', event.message.type);
    }

    if (reply_message) {
        event.reply(reply_message).then(function(data) {
            logger.debug('Success to reply message event');
        }).catch(function(error) {
            logger.error('Failed to reply message event', error);
        });
    }
});

//Express API --------- App.get('path', callback function);
//routes HTTP GET requests to the specified path with the specified callback functions
app.get('/', function(request, response) {
    response.json({ message: 'response from node service!' });
});

app.post('/ajax', function(request, response) {
    response.send("response by ajax");
});
