const FOLDER_NAME = "Folder Name which is logs are saved";
const SpreadSheetName = "SpreadSheet Name which is logs are saved";

const FOLDER_ID = PropertiesService.getScriptProperties().getProperty('folder_id');
if (!FOLDER_ID) {
  throw 'You should set "folder_id" property from [File] > [Project properties] > [Script properties]';
}
const API_TOKEN = PropertiesService.getScriptProperties().getProperty('slack_api_token');
if (!API_TOKEN) {
  throw 'You should set "slack_api_token" property from [File] > [Project properties] > [Script properties]';
}


function FindOrCreateFolder(folder, folderName) {
  var itr = folder.getFoldersByName(folderName);
  if (itr.hasNext()) {
    return itr.next();
  }
  var newFolder = folder.createFolder(folderName);
  newFolder.setName(folderName);
  return newFolder;
}

function FindOrCreateSpreadsheet(folder, fileName) {
  var it = folder.getFilesByName(fileName);
  if (it.hasNext()) {
    var file = it.next();
    return SpreadsheetApp.openById(file.getId());
  }
  else {
    var ss = SpreadsheetApp.create(fileName);
    folder.addFile(DriveApp.getFileById(ss.getId()));
    return ss;
  }
}

// Slack 上にアップロードされたデータをダウンロード
function DownloadData(url, folder, savefilePrefix) {
  var options = {
    "headers": { 'Authorization': 'Bearer ' + API_TOKEN }
  };
  var response = UrlFetchApp.fetch(url, options);
  var fileName = savefilePrefix + "_" + url.split('/').pop();
  var fileBlob = response.getBlob().setName(fileName);

  console.log("Download: " + url + "\n =>" + fileName);

  // もし同名ファイルがあったら削除してから新規に作成
  var itr = folder.getFilesByName(fileName);
  if (itr.hasNext()) {
    folder.removeFile(itr.next());
  }
  return folder.createFile(fileBlob);
}

// Slack テキスト整形
function UnescapeMessageText(text, memberList) {
  return (text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/<@(.+?)>/g, function ($0, userID) {
      var name = memberList[userID];
      return name ? "@" + name : $0;
    });
};


// Slack へのアクセサ
var SlackAccessor = (function () {
  function SlackAccessor(apiToken) {
    this.APIToken = apiToken;
  }

  var MAX_HISTORY_PAGINATION = 10;
  var HISTORY_COUNT_PER_PAGE = 1000;

  var p = SlackAccessor.prototype;

  // API リクエスト
  p.requestAPI = function (path, params) {
    if (params === void 0) { params = {}; }
    var url = "https://slack.com/api/" + path + "?";
    var qparams = [("token=" + encodeURIComponent(this.APIToken))];
    for (var k in params) {
      qparams.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    }
    url += qparams.join('&');

    console.log("==> GET " + url);

    var response = UrlFetchApp.fetch(url);
    var data = JSON.parse(response.getContentText());
    if (data.error) {
      console.log(data);
      console.log(params);
      throw "GET " + path + ": " + data.error;
    }
    return data;
  };

  // メンバーリスト取得
  p.requestMemberList = function () {
    var response = this.requestAPI('users.list');
    var memberNames = {};
    response.members.forEach(function (member) {
      memberNames[member.id] = member.name;
      console.log("memberNames[" + member.id + "] = " + member.name);
    });
    return memberNames;
  };

  // チャンネル情報取得
  p.requestChannelInfo = function () {
    var response = this.requestAPI('conversations.list');
    response.channels.forEach(function (channel) {
      console.log("channel(id:" + channel.id + ") = " + channel.name);
    });
    return response.channels;
  };

  // 特定チャンネルのメッセージ取得
  p.requestMessages = function (channel, oldest) {
    var _this = this;
    if (oldest === void 0) { oldest = '1'; }

    var messages = [];
    var options = {};
    options['oldest'] = oldest;
    options['count'] = HISTORY_COUNT_PER_PAGE;
    options['channel'] = channel.id;

    var loadChannelHistory = function (oldest) {
      if (oldest) {
        options['oldest'] = oldest;
      }
      var response = _this.requestAPI('conversations.history', options);
      messages = response.messages.concat(messages);
      return response;
    };

    var resp = loadChannelHistory();
    var page = 1;
    while (resp.has_more && page <= MAX_HISTORY_PAGINATION) {
      resp = loadChannelHistory(resp.messages[0].ts);
      page++;
    }
    console.log("channel(id:" + channel.id + ") = " + channel.name + " => loaded messages.");
    // 最新レコードを一番下にする
    return messages.reverse();
  };

  // 特定チャンネルの特定のスレッドのメッセージ取得
  p.requestThreadMessages = function (channel, ts_array, oldest) {
    var all_messages = [];
    let _this = this;

    var loadThreadHistory = function (options, oldest) {
      if (oldest) {
        options['oldest'] = oldest;
      }
      Utilities.sleep(1250);
      var response = _this.requestAPI('conversations.replies', options);

      return response;
    };
    ts_array = ts_array.reverse();

    ts_array.forEach(ts => {
      if (oldest === void 0) { oldest = '1'; }

      let options = {};
      options['oldest'] = oldest;
      options['ts'] = ts;
      options['count'] = HISTORY_COUNT_PER_PAGE;
      options['channel'] = channel.id;

      let messages = [];
      let resp;
      resp = loadThreadHistory(options);
      messages = resp.messages.concat(messages);
      var page = 1;
      while (resp.has_more && page <= MAX_HISTORY_PAGINATION) {
        resp = loadThreadHistory(options, resp.messages[0].ts);
        messages = resp.messages.concat(messages);
        page++;
      }
      // 最初の投稿はスレッド元なので削除
      messages.shift();
      // 最新レコードを一番下にする
      all_messages = all_messages.concat(messages);
      console.log("channel(id:" + channel.id + ") = " + channel.name + " ts = " + ts + " => loaded replies.");
    });
    return all_messages;
  };
  return SlackAccessor;
})();


// スプレッドシートへの操作
var SpreadsheetController = (function () {
  function SpreadsheetController(spreadsheet, folder) {
    this.ss = spreadsheet;
    this.folder = folder;
  }

  const COL_DATE = 1; // 日付・時間(タイムスタンプから読みやすい形式にしたもの)
  const COL_USER = 2; // ユーザ名 
  const COL_TEXT = 3; // テキスト内容
  const COL_URL = 4;  // URL
  const COL_LINK = 5; // ダウンロードファイルリンク
  const COL_TIME = 6; // 差分取得用に使用するタイムスタンプ
  const COL_REPLY_COUNT = 7; // スレッド内の投稿数
  const COL_JSON = 8; // 念の為取得した JSON をまるごと記述しておく列

  const COL_MAX = COL_JSON;  // COL 最大値

  const COL_WIDTH_DATE = 130;
  const COL_WIDTH_TEXT = 800;
  const COL_WIDTH_URL = 400;

  var p = SpreadsheetController.prototype;

  // シートを探してなかったら新規追加
  p.findOrCreateSheet = function (sheetName) {
    var sheet = null;
    var sheets = this.ss.getSheets();
    sheets.forEach(function (s) {
      var name = s.getName();
      if (name == sheetName) {
        sheet = s;
        return;
      }
    });
    if (sheet == null) {
      sheet = this.ss.insertSheet();
      sheet.setName(sheetName);
      // 各 Column の幅設定
      sheet.setColumnWidth(COL_DATE, COL_WIDTH_DATE);
      sheet.setColumnWidth(COL_TEXT, COL_WIDTH_TEXT);
      sheet.setColumnWidth(COL_URL, COL_WIDTH_URL);
    }
    return sheet;
  };

  // チャンネルからシート名取得
  p.channelToSheetName = function (channel) {
    return channel.name + " (" + channel.id + ")";
  };

  // チャンネルごとのシートを取得
  p.getChannelSheet = function (channel) {
    var sheetName = this.channelToSheetName(channel);
    return this.findOrCreateSheet(sheetName);
  };
  p.sortSheet = function (channel) {
    var sheet = this.getChannelSheet(channel);
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    sheet.getRange(1, 1, lastRow, lastCol).sort(COL_TIME);
  };

  // 最後に記録したタイムスタンプ取得
  p.getLastTimestamp = function (channel) {
    var sheet = this.getChannelSheet(channel);
    var lastRow = sheet.getLastRow();
    if (lastRow > 0) {
      return sheet.getRange(lastRow, COL_TIME).getValue();
    }
    return '1';
  };

  // スレッドが存在するものを取得
  p.getThreadTS = function (channel, first_ts) {
    var sheet = this.getChannelSheet(channel);
    var lastRow = sheet.getLastRow();
    if (lastRow > 0) {
      console.log('lastRow > 0');
      let first_row = 0;
      for (let i = 1; i <= lastRow; i++) {
        ts = sheet.getRange(i, COL_TIME).getValue();
        if (ts > first_ts) {
          first_row = i;
          break;
        }
      }
      let ts_array = [];
      if (first_row == 0) {
        return '1';
      }
      for (let i = first_row; i <= lastRow; i++) {
        if (!(sheet.getRange(i, COL_REPLY_COUNT).isBlank())) {
          ts = sheet.getRange(i, COL_TIME).getValue();
          ts_array.push(ts.toFixed(6).toString());
        }
      }

      return ts_array;
    }
    return '1';
  };

  // ダウンロードフォルダの確保
  p.getDownloadFolder = function (channel) {
    var sheetName = this.channelToSheetName(channel);
    return FindOrCreateFolder(this.folder, sheetName);
  };

  // 取得したチャンネルのメッセージを保存する
  p.saveChannelHistory = function (channel, messages, memberList) {
    console.log("saveChannelHistory: " + this.channelToSheetName(channel));
    var _this = this;

    var sheet = this.getChannelSheet(channel);
    var lastRow = sheet.getLastRow();
    var currentRow = lastRow + 1;

    // チャンネルごとにダウンロードフォルダを用意する
    var downloadFolder = this.getDownloadFolder(channel);

    var record = [];
    // メッセージ内容ごとに整形してスプレッドシートに書き込み
    messages.forEach(function (msg) {
      var date = new Date(+msg.ts * 1000);
      console.log("message: " + date);

      var row = [];

      // 日付
      var date = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
      row[COL_DATE - 1] = date;
      // ユーザー名
      row[COL_USER - 1] = memberList[msg.user] || msg.username;
      // Slack テキスト整形
      row[COL_TEXT - 1] = UnescapeMessageText(msg.text, memberList);
      // アップロードファイル URL とダウンロード先 Drive の Viewer リンク
      var url = "";
      var alternateLink = "";
      if (msg.upload == true) {
        url = msg.files[0].url_private_download;
        console.log("url: " + url)
        if (msg.files[0].mode == 'tombstone' || msg.files[0].mode == 'hidden_by_limit') {
          url = "";
        } else {
          // ダウンロードとダウンロード先
          var file = DownloadData(url, downloadFolder, date);
          var driveFile = DriveApp.getFileById(file.getId());
          alternateLink = driveFile.alternateLink;
        }
      }
      row[COL_URL - 1] = url;
      row[COL_LINK - 1] = alternateLink;
      row[COL_TIME - 1] = msg.ts;
      if ('reply_count' in msg) {
        row[COL_REPLY_COUNT - 1] = msg.reply_count;
      }
      // メッセージの JSON 形式
      row[COL_JSON - 1] = JSON.stringify(msg);

      record.push(row);
    });

    if (record.length > 0) {
      var range = sheet.insertRowsAfter(lastRow || 1, record.length)
        .getRange(lastRow + 1, 1, record.length, COL_MAX);
      range.setValues(record);
    }

  };

  return SpreadsheetController;
})();

function Run() {
  let folder = FindOrCreateFolder(DriveApp.getFolderById(FOLDER_ID), FOLDER_NAME);
  let ss = FindOrCreateSpreadsheet(folder, SpreadSheetName);

  let ssCtrl = new SpreadsheetController(ss, folder);
  let slack = new SlackAccessor(API_TOKEN);

  // メンバーリスト取得
  const memberList = slack.requestMemberList();
  // チャンネル情報取得
  const channelInfo = slack.requestChannelInfo();

  // チャンネルごとにメッセージ内容を取得 
  let first_exec_in_this_channel = false;
  let timestamp_array = [];
  for (let ch of channelInfo) {
    let timestamp = ssCtrl.getLastTimestamp(ch);
    let messages = slack.requestMessages(ch, timestamp);
    ssCtrl.saveChannelHistory(ch, messages, memberList);
    timestamp_array.push(timestamp);
    if (timestamp == '1') {
      first_exec_in_this_channel = true;
      break;
    }
  };

  // スレッドは重い処理なので各回に1回のみ行う
  const ch_num = (parseInt(PropertiesService.getScriptProperties().getProperty('last_channel_no')) + 1) % channelInfo.length;
  console.log('ch_num');
  console.log(ch_num);
  const ch = channelInfo[ch_num]
  console.log(ch);
  // スプレッドシートの最後(初めての書き込みのときは0にする)
  let timestamp;
  // スレッド元が1か月前の投稿から現在まで(初めての書き込みのときは全てを対象)
  let first;
  if (first_exec_in_this_channel) {
    timestamp = 0;
    first = '1';
  } else {
    timestamp = timestamp_array[ch_num];
    first = (parseFloat(timestamp) - 2592000).toString();
  }
  //  チャンネル内のスレッド元のtsをすべて取得  
  const ts_array = ssCtrl.getThreadTS(ch, timestamp);
  console.log('ts_array.length');
  console.log(ts_array.length);
  //  ts_arrayに存在するスレッドかつ最終更新以降の投稿を取得
  if (ts_array != '1') {
    const thread_messages = slack.requestThreadMessages(ch, ts_array, timestamp);
    // save messages and files
    // unfortunately, not all files are saved (bug)
    ssCtrl.saveChannelHistory(channelInfo[ch_num], thread_messages, memberList);

    // sort by timestamp
    ssCtrl.sortSheet(ch);
  }
  // 最後にスレッド情報を集めたチャンネルを保存
  PropertiesService.getScriptProperties().setProperty('last_channel_no', ch_num);
}
