function SetProperties() {
  PropertiesService.getScriptProperties().setProperty('slack_api_token', 'Your OAuth Access Token');
  PropertiesService.getScriptProperties().setProperty('folder_id', 'hogehoge');
  PropertiesService.getScriptProperties().setProperty('last_channel_no', -1);
}
