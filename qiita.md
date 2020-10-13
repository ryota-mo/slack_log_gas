無料版Slackの最大の悩みである**1万件を超過するとログが失われる**問題．~~それをわかって無料版を用いているはずなのに~~保存する必要に迫られたので備忘録です．

Slackの1万件のいやらしいところ，「Aさんがチャンネルに参加しました」投稿も多分1件にカウントされているんですよね．ユーザ数が多いと大変．

1年位前までは簡単にできたのですが，**2020年下半期以降，最近のSlackの潮流から方法が厄介になってしまった**のでその点も併せて書いていきます．

# 目次
1. [サマリー](#サマリー)
1. [スクリプト保存先](#スクリプト保存先)
1. [Slack公式のAPI](#slack公式のapi)
1. [2020年になにが起きたか？](#2020年になにが起きたか)
1. [API変更の問題点](#api変更の問題点)
1. [作成したプログラム](#作成したプログラム)
1. [Limitations](#limitations)
1. [参考にしたサイト](#参考にしたサイト)

# サマリー
- Slack APIにおける`channels.history`, `channels.list`などの`channels.*`が廃止
- `conversations.history`に移行する必要があるが，`channels.history`でとれていた「スレッド内の投稿=チャンネルには投稿されていないもの」が取れなくなった
- `conversations.replies`でスレッド内の投稿は取れるが，スレッドごとにAPIの呼び出しが必要で，呼び出し回数制限が厄介

# スクリプト保存先
https://github.com/ryota-mo/slack_log_gas
(使った場合はぜひスターをお願いします！)

# Slack公式のAPI
Slackは公式でAPIを公開しています([https://api.slack.com/](https://api.slack.com/))．さらに，メソッドなども~~何が返ってくるかの明示的な一覧がない以外は~~なにをpostすればいいかもきちんと書かれています．

- メソッド一覧: https://api.slack.com/methods

さらに，webでpostするだけでなく，Python用などのライブラリなども整備されており至れり尽くせり状態です．

# 2020年になにが起きたか？
## APIの変更
元々のAPIでは以下のメソッドを用いるとメッセージに関する情報が取得できていました．

- channels.hoge (パブリックチャンネル)
- groups.hoge (プライベートチャンネル)
- im.hoge (DM)
- mpim.hoge (複数人のDM)

hogeにはhistory(特定のチャンネルのメッセージの履歴), list(チャンネルの一覧), info(特定のチャンネルの情報)などを用いることができ，パブリックチャンネルやプライベートチャンネルごとに処理を書き換えなければいけない問題はありました．

その影響か，これら4つのメソッドを`conversations.hoge`に変更することが発表されました．4つのメソッドは廃止予定であり，速やかに移行するよう要請しています．

https://api.slack.com/changelog/2020-01-deprecating-antecedents-to-the-conversations-api

廃止日が伸びたものの，2021年2月24日に4つのメソッドは廃止されることが決まっており，さらに2020年6月10日以降に新しく作成されたアプリはこれらのメソッドを使うことができなくなりました．

## API変更の影響
ところが，この影響で`channels.history`でできていたあることが`conversations.hisotry`ではできなくなりました．それが**スレッド内のメッセージの取得**です．

つまり，

- `channels.history`APIではスレッド内の投稿もチャンネルへの投稿も分け隔てなく投稿の日時順に並んで返ってきた（指定するのはチャンネルのみ）
- `conversations.hisotry`では**チャンネルへの投稿のみが日時順に並んで返ってくる**ように変更された（指定するのはチャンネルのみ）

ということが起きました．さらに，スレッド内の投稿を取得するためには

- `conversations.replies`というAPIを用いて，以下の2つを指定して取得
    - チャンネル
    - スレッドの元となっているチャンネルへの投稿のタイムスタンプ

というようになりました．なお，Slackの投稿は「ワークスペース，チャンネル，タイムスタンプ(小数第6桁まで)」の3つで一意に定まるようです．

# API変更の問題点
以上の変更から以下の問題が起きました．

- スレッド内の投稿の取得にはタイムスタンプも指定したうえで各スレッドごとに1回APIを叩く必要がある
- `conversations.replies`APIは1分間に50回程度しか呼び出しができない(Tier 3, Rate Limitsについては[こちら](https://api.slack.com/docs/rate-limits))

APIの呼び出し制限は`Tier`を見るとわかります．`channels.history`も1分間に50回程度の制限があったのですが，1回あたり数百程度の党校は投稿は取得できました．`conversations.history`も同様ですが，**スレッド内の投稿は取ってこれないため，`conversations.replies`をスレッドの数だけ呼び出す必要があるため，この制限も気にしないといけません．**


# 作成したプログラム
## 工程
プログラムは以下のような工程を行います．

1. 保存先フォルダの確認・生成
2. チャンネルの一覧などを取得
3. 各チャンネルの「チャンネルへの投稿」を取得，スプレッドシートに記載，ファイル類を保存できるものを保存
4. その実行時に更新対象になっているチャンネルのスレッドへの投稿を更新

「保存先フォルダの確認・生成」はGASのAPIを呼び出します．また，「チャンネルの一覧などを取得」は`conversations.list`から取得可能です．ここで，**パブリックチャンネルに関しては参加していないチャンネルであっても取得されます**．

「チャンネルへの投稿の保存」では以下のようなスクリプトを動かします．

```js
  let first_exec_in_this_channel = false;
  for (let ch of channelInfo) {
    let timestamp = ssCtrl.getLastTimestamp(ch, 0);
    let messages = slack.requestMessages(ch, timestamp);
    ssCtrl.saveChannelHistory(ch, messages, memberList);
    if (timestamp == '1') {
      first_exec_in_this_channel = true;
      break;
    }
  };
```

(JavaScriptの経験が浅いのでツッコミどころあったらごめんなさい:bow:）

なお，タイムスタンプの取得には下記のようなスクリプトを組んでいます．

```js
  p.getLastTimestamp = function (channel, is_reply) {
    var sheet = this.getChannelSheet(channel);
    var lastRow = sheet.getLastRow();
    if (lastRow > 0) {
      let row_of_last_update = 0;
      for (let row_no = lastRow; row_no >= 1; row_no--) {
        if (parseInt(sheet.getRange(row_no, COL_IS_REPLY).getValue()) == is_reply) {
          row_of_last_update = row_no;
          break;
        }
      }
      if (row_of_last_update === 0) {
        return '1';
      }
      console.log('last timestamp row: ' + row_of_last_update);
      console.log('last timestamp: ' + sheet.getRange(row_of_last_update, COL_TIME).getValue());
      return sheet.getRange(row_of_last_update, COL_TIME).getValue();
    }
    return '1';
  };
```

`first_exec_in_this_channel`を用いて「そのチャンネルの情報をいままでに登録したことがあるか=スプレッドシートが白紙でないか」をチェックします．これは`ssCtrl.getLastTimestamp(ch)`においてチャンネルのスプレッドシートの最後の行のタイムスタンプを確認し，白紙の時は`'1'`を返すようにしておいてこれを判定基準とし，`timestamp == '1'`のときには白紙として他のチャンネルの「チャンネルへの投稿」の情報の収集をやめてしまい，「スレッドに投稿されたメッセージの取得」フェーズに移行します．そうでないときには全チャンネルの情報を取得します．

全チャンネルの情報を取得するときにはどのチャンネルを対象にするかを保持する必要があります．そのためには「プロジェクトのプロパティ」を用いました．

```js
  const ch_num = (parseInt(PropertiesService.getScriptProperties().getProperty('last_channel_no')) + 1) % channelInfo.length;
  const ch = channelInfo[ch_num]
```

`last_channel_no`というキーの値にチャンネルの配列のインデックス（`conversations.list`で返ってくる配列の順番は固定のはず）を保持しておき，これを取得します．

これをもとに，そのチャンネルの「前回更新時の最後のタイムスタンプがいつか」の情報を取得します．

```js
  // スプレッドシートの最後(初めての書き込みのときは0にする)
  let timestamp;
  // スレッド元が1か月前の投稿から現在まで(初めての書き込みのときは全てを対象)
  let first;
  if (first_exec_in_this_channel) {
    timestamp = 0;
    first = '1';
  } else {
    timestamp = ssCtrl.getLastTimestamp(ch, 1);
    first = (parseFloat(timestamp) - 2592000).toString();
  }
```
なお，初めての時には`first_exec_in_this_channel`のフラグを用いてタイムスタンプを0にします．このタイムスタンプはAPI呼び出し時の`oldest`に用いられ，もっとも古い投稿の日時を指定できます．これを0にしておけば，APIを呼び出す際に，もっとも古いタイムスタンプを0にすることになり，事実上すべての投稿を取得できます．また，初めてでないときには`timestamp`に各チャンネルの前回のスレッド更新時のタイムスタンプを取得でき，これをもとに保存できます．また，このときはそのタイムスタンプから`2592000`を引く，つまり60秒x60分x24時間x31日を引くことで，1か月前以降にチャンネルに投稿されたものを対象としてみました．これはすべてのものを対象にすると，だんだんとAPIの呼び出し回数が増えること，また1か月前のスレッドはさすがにあまり使われないだろうという判断です．

次に，そのチャンネルに存在するスレッドのタイムスタンプを取得します．これはスプレッドシートの情報をもとに検索します．

```js
  //  チャンネル内のスレッド元のtsをすべて取得  
  const ts_array = ssCtrl.getThreadTS(ch, timestamp);

```

そして，得たタイムスタンプの配列に存在するスレッドかつ最終更新以降の投稿を取得します．ただし，スレッドが存在しなかった時の処理だけ追加しておきます．

```js
  if (ts_array != '1') {
    const thread_messages = slack.requestThreadMessages(ch, ts_array, timestamp);

```

スレッドへの投稿もファイル類を取得しておきます．

```js
    // save messages and files
    // unfortunately, not all files are saved (bug)
    ssCtrl.saveChannelHistory(channelInfo[ch_num], thread_messages, memberList);
```

最後に，現状はチャンネルへの投稿はタイムスタンプ順にソートされ，さらに各スレッド内の投稿もソート済であるもののこれらがそのまま結合されていて気持ち悪いので，タイムスタンプですべてソートしておきます．

```js
    // sort by timestamp
    ssCtrl.sortSheet(ch);
```

## 呼び出し回数制限回避のための苦肉の策
スレッド内の投稿を取得するため，このプログラムでは[conversations.replies](https://api.slack.com/methods/conversations.replies)を利用します．このAPIはそれぞれのスレッドごとに1回呼び出す必要があります．さらに，`conversations.replies`はRate limitingが`Tier 3`，つまり1分間に50回程度しか呼び出すことができず超過した場合にはAPIを呼び出してもエラーが返ってきます．この制限を守るため，Google Apps Scriptの実行時間の制限(G Suite Business / Enterprise / Education以外の場合には6分程度, [https://developers.google.com/apps-script/guides/services/quotas](https://developers.google.com/apps-script/guides/services/quotas))を超える可能性があります．
**実行時間の超過を防ぐため，1回の実行では1つのチャンネル内の投稿のみ取得します．全チャンネルのスレッドの投稿を取得するためには，チャンネル数と同じ回数実行する必要があります．**

# 実際の使い方とセットアップ方法
## Step1: Slack Appを作成する
**NOTE**
各WorkSpaceでSlack Appを1つ作成する必要があります。(無料プランを利用してる方が閲覧しているかと存じますが) 無料プランを利用している場合，10件のアプリしか導入できないことに留意してください．

1. [https://api.slack.com/apps](https://api.slack.com/apps)にアクセスします．
1. "Create a Slack App"をクリックし，フォームに記入します．
![Create_a_Slack_App.PNG](https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/356864/391a9ffc-07b6-adb0-6961-6ab989875da5.png)
1. "OAuth & Permissions"に移動し，"Scopes"内にある"User Token Scopes"を見つけ，"Add an OAuth Scope"をクリックして以下の4つのOAuth Scopesを追加します．
    1. channels:history
    1. channels:read
    1. files:read
    1. users:read
![User_Token_Scopes.PNG](https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/356864/24387779-8a97-7687-1c00-520633feda2c.png)
1. "Install App to Workspace"をクリックしてワークスペースにインストールし，"OAuth Access Token"を控えておきます．
![OAuth_Tokens_and_Redirect_URLs.PNG](https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/356864/60b68d04-4391-2229-97d6-ef2914236f79.png)



## Step2: Google Apps Scriptプロジェクトの作成
1. Google DriveなどからGoogle Apps Scriptのプロジェクトを作成します．
2. プロジェクトのフォルダIDを確認します．プロジェクトのGoogle DriveのURLが`https://drive.google.com/drive/folders/hogehoge`ならば，folder ID は `hogehoge`です．
1. [slack_log_gas.gs](https://github.com/ryota-mo/slack_log_gas/blob/main/slack_log_gas.gs)をコピー&ペースト等を用いて作成します．
1. [slack_log_gas.gs](https://github.com/ryota-mo/slack_log_gas/blob/main/slack_log_gas.gs)の1, 2行目の`FOLDER_NAME`と`SpreadSheetName`を自身の設定したいログのフォルダ名とスプレッドシート名に変更してください．
1. ファイル->プロジェクトのプロパティから「スクリプトのプロパティタブ」に移動し，以下の3つのプロパティを追加します．

    |  Key  |  Value  |
    |:-------:|:-------:|
    |  slack_api_token  |  Slackで控えたOAuth Access Token |
    |  folder_id  |  hogehoge  |
    | last_channel_no | -1 |
1. GUIを用いた設定がうまくできない場合には[set_properties.gs](https://github.com/ryota-mo/slack_log_gas/blob/main/set_properties.gs)を用いてみてください．その際，値を自身のものに置き換えてください．
1. `Run`関数を実行するか，トリガーの設定をします．全チャンネルの全スレッドを取得したい場合にはチャンネルの数と同じ回数の実行が必要です．
1. "Authorization required"のポップアップが出てきた場合には言われた通り権限を設定してください．


# Limitations
- 残念ながら，すべてのファイルが保存されるわけではありません（解決されていません)
- スレッド内の投稿についてはチャンネルごとに前回のログ取得時の最新のログから1か月前より後に**チャンネルに**投稿された(つまりスレッド内の投稿でない)メッセージ内のスレッドを追加します．チャンネルへの投稿が1か月より前かつスレッドへの投稿が1か月以内のものは取得されません．
- たまに行の重複がおきます．


# 参考にしたサイト
- [[GAS] Slack ログをアップロードデータを含めて GoogleDrive に自動保存する](https://negimochi.work/gas-slack-log/)
- [上記サイトのレポジトリ](https://github.com/negimochi/SlackLogGAS/blob/master/SlackLog.gs)
