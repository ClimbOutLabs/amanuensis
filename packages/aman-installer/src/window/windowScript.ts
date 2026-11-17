// The setup window: one fixed script that Windows PowerShell runs, and
// the one fixed line that starts it. Both are constants. Nothing a
// person types and nothing the installer prints is ever made part of
// them: every word and every answer crosses as a message and is shown
// as plain text. The script loads nothing by name lookup, writes
// nothing to disk, and prints nothing but frames.

// The largest script the start line will read.
export const WINDOW_SCRIPT_CAP = 262144;

// The start line reads the script's length (four bytes) and then the
// script from standard input, and runs it with the input stream. It
// leaves PowerShell at once when anything is not as expected.
export const WINDOW_BOOTSTRAP = [
  "$ErrorActionPreference='Stop'",
  "$PSModuleAutoLoadingPreference='None'",
  '$i=[Console]::OpenStandardInput()',
  '$h=[byte[]]::new(4)',
  '$n=0',
  'while($n -lt 4){$r=$i.Read($h,$n,4-$n);if($r -le 0){exit 3};$n+=$r}',
  '$l=([int]$h[0] -shl 24) -bor ([int]$h[1] -shl 16) -bor ([int]$h[2] -shl 8) -bor [int]$h[3]',
  'if($l -le 0 -or $l -gt 262144){exit 3}',
  '$b=[byte[]]::new($l)',
  '$n=0',
  'while($n -lt $l){$r=$i.Read($b,$n,$l-$n);if($r -le 0){exit 3};$n+=$r}',
  '$null=& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($b))) $i',
].join(';');

export const WINDOW_SCRIPT = String.raw`param($stdin)
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 4 }

[void][Reflection.Assembly]::Load('PresentationFramework, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
[void][Reflection.Assembly]::Load('PresentationCore, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
[void][Reflection.Assembly]::Load('WindowsBase, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
[void][Reflection.Assembly]::Load('System.Xaml, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')

$stdout = [Console]::OpenStandardOutput()
$utf8 = [Text.UTF8Encoding]::new($false)
$json = [Web.Script.Serialization.JavaScriptSerializer]::new()
$json.MaxJsonLength = 131072

$S = @{
  buf = [byte[]]::new(131072)
  have = 0
  task = $null
  ended = $false
  confirmClose = $false
  panel = 'none'
  screen = 'none'
  rows = @{}
  words = $null
  ruleOk = $false
}

function Send-Frame([byte]$kind, [byte[]]$payload, [int]$count) {
  $head = [byte[]]::new(5)
  $head[0] = $kind
  $head[1] = ($count -shr 24) -band 255
  $head[2] = ($count -shr 16) -band 255
  $head[3] = ($count -shr 8) -band 255
  $head[4] = $count -band 255
  $stdout.Write($head, 0, 5)
  if ($count -gt 0) { $stdout.Write($payload, 0, $count) }
  $stdout.Flush()
}

function Send-Message($message) {
  $bytes = $utf8.GetBytes($json.Serialize($message))
  Send-Frame 1 $bytes $bytes.Length
}

# The password is read from the box as protected text only, copied
# into arrays that are pinned so they cannot be moved or copied behind
# our back, and those arrays are wiped by Clear-Secret. No text copy of
# the password is ever made.
function Read-Secret($box) {
  $secure = $box.SecurePassword
  $n = $secure.Length
  $chars = [char[]]::new($n + 1)
  $pinChars = [Runtime.InteropServices.GCHandle]::Alloc($chars, [Runtime.InteropServices.GCHandleType]::Pinned)
  $bytes = [byte[]]::new(($n * 3) + 4)
  $pinBytes = [Runtime.InteropServices.GCHandle]::Alloc($bytes, [Runtime.InteropServices.GCHandleType]::Pinned)
  $count = 0
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secure)
  try {
    if ($n -gt 0) {
      [Runtime.InteropServices.Marshal]::Copy($ptr, $chars, 0, $n)
      $count = $utf8.GetBytes($chars, 0, $n, $bytes, 0)
    }
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($ptr)
    [Array]::Clear($chars, 0, $chars.Length)
    $pinChars.Free()
    $secure.Dispose()
  }
  return @{ bytes = $bytes; pin = $pinBytes; len = $count }
}

function Clear-Secret($secret) {
  [Array]::Clear($secret.bytes, 0, $secret.bytes.Length)
  $secret.pin.Free()
}

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="780" Height="560" MinWidth="660" MinHeight="500"
        WindowStartupLocation="CenterScreen" FontFamily="Segoe UI" FontSize="14"
        Background="#FFFBF8F2" UseLayoutRounding="True">
  <Grid>
    <Grid.ColumnDefinitions>
      <ColumnDefinition Width="220"/>
      <ColumnDefinition Width="*"/>
    </Grid.ColumnDefinitions>
    <Border Grid.Column="0" Background="#FF22303C" Padding="22,30,16,22">
      <StackPanel>
        <TextBlock x:Name="Brand" Foreground="White" FontSize="24" FontWeight="SemiBold" Margin="0,0,0,26"/>
        <StackPanel x:Name="Steps"/>
      </StackPanel>
    </Border>
    <Grid Grid.Column="1" Margin="34,30,34,22">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>
      <TextBlock x:Name="Title" Grid.Row="0" FontSize="25" FontWeight="SemiBold" Foreground="#FF1B2630" TextWrapping="Wrap" Margin="0,0,0,14"/>
      <ScrollViewer x:Name="ContentScroll" Grid.Row="1" VerticalScrollBarVisibility="Auto">
        <StackPanel Margin="0,0,8,0">
          <TextBlock x:Name="Body" TextWrapping="Wrap" LineHeight="22" Foreground="#FF2B3640"/>
          <StackPanel x:Name="Rows" Margin="0,14,0,0"/>
          <StackPanel x:Name="AboutPanel" Visibility="Collapsed" Margin="0,14,0,0">
            <TextBlock x:Name="EmailLabel" FontWeight="SemiBold" Margin="0,0,0,4"/>
            <TextBox x:Name="EmailBox" MaxLength="254" Padding="6,5" Margin="0,0,0,14"/>
            <TextBlock x:Name="PasswordLabel" FontWeight="SemiBold" Margin="0,0,0,4"/>
            <PasswordBox x:Name="PassBox" MaxLength="72" Padding="6,5" Margin="0,0,0,8"/>
            <TextBlock x:Name="Rule0" TextWrapping="Wrap" Margin="0,1"/>
            <TextBlock x:Name="Rule1" TextWrapping="Wrap" Margin="0,1"/>
            <TextBlock x:Name="Rule2" TextWrapping="Wrap" Margin="0,1"/>
            <TextBlock x:Name="AgainLabel" FontWeight="SemiBold" Margin="0,12,0,4"/>
            <PasswordBox x:Name="AgainBox" MaxLength="72" Padding="6,5" Margin="0,0,0,8"/>
            <TextBlock x:Name="Rule3" TextWrapping="Wrap" Margin="0,1"/>
            <TextBlock x:Name="KeepLine" TextWrapping="Wrap" Foreground="#FF55606A" Margin="0,12,0,0"/>
          </StackPanel>
          <StackPanel x:Name="OptionsPanel" Visibility="Collapsed" Margin="0,16,0,0">
            <RadioButton x:Name="PhoneYes" GroupName="Phone" Margin="0,0,0,10"/>
            <RadioButton x:Name="PhoneNo" GroupName="Phone" IsChecked="True"/>
          </StackPanel>
          <Expander x:Name="Details" Visibility="Collapsed" Margin="0,14,0,0">
            <TextBox x:Name="DetailsText" IsReadOnly="True" Height="150" Margin="0,6,0,0"
                     VerticalScrollBarVisibility="Auto" TextWrapping="Wrap" FontFamily="Consolas" FontSize="12"/>
          </Expander>
          <TextBlock x:Name="Problem" Foreground="#FF9B241C" FontWeight="SemiBold" TextWrapping="Wrap" Margin="0,12,0,0"/>
        </StackPanel>
      </ScrollViewer>
      <StackPanel Grid.Row="3" Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,16,0,0">
        <Button x:Name="BackButton" MinWidth="96" Padding="14,7" Margin="0,0,10,0" Visibility="Collapsed"/>
        <Button x:Name="NextButton" MinWidth="124" Padding="14,7" IsDefault="True" Visibility="Collapsed"/>
      </StackPanel>
    </Grid>
  </Grid>
</Window>
'@

$window = [Windows.Markup.XamlReader]::Parse($xaml)
$ui = @{}
foreach ($name in @('Brand','Steps','Title','Body','ContentScroll','Rows','AboutPanel','EmailLabel','EmailBox','PasswordLabel','PassBox','Rule0','Rule1','Rule2','Rule3','AgainLabel','AgainBox','KeepLine','OptionsPanel','PhoneYes','PhoneNo','Details','DetailsText','Problem','BackButton','NextButton')) {
  $ui[$name] = $window.FindName($name)
}

$markTodo = [string][char]0x25CB
$markDoing = [string][char]0x25CF
$markDone = [string][char]0x2713
$markFailed = [string][char]0x2715
$brushOk = [Windows.Media.SolidColorBrush]::new([Windows.Media.Color]::FromRgb(0x1E, 0x7D, 0x4F))
$brushBad = [Windows.Media.SolidColorBrush]::new([Windows.Media.Color]::FromRgb(0xB3, 0x26, 0x1E))
$brushPlain = [Windows.Media.SolidColorBrush]::new([Windows.Media.Color]::FromRgb(0x2B, 0x36, 0x40))
$brushQuiet = [Windows.Media.SolidColorBrush]::new([Windows.Media.Color]::FromRgb(0x61, 0x6D, 0x77))
$brushRailQuiet = [Windows.Media.SolidColorBrush]::new([Windows.Media.Color]::FromRgb(0xB7, 0xC4, 0xCF))
$brushWhite = [Windows.Media.SolidColorBrush]::new([Windows.Media.Color]::FromRgb(0xFF, 0xFF, 0xFF))
$visible = [Windows.Visibility]::Visible
$collapsed = [Windows.Visibility]::Collapsed

function Set-Mark($block, [string]$label, [string]$mark) {
  $index = 0
  if ($mark -eq 'doing') { $index = 1 }
  elseif ($mark -eq 'done') { $index = 2 }
  elseif ($mark -eq 'failed') { $index = 3 }
  if ($S.screen -eq 'review') { [Windows.Automation.AutomationProperties]::SetName($block, $label) }
  else { [Windows.Automation.AutomationProperties]::SetName($block, ([string]$S.words['markLabels'][$index] + ': ' + $label)) }
  $display = $label
  if ($S.screen -eq 'check' -or $S.screen -eq 'install' -or $S.screen -eq 'stopped') { $display = [string]$S.words['markLabels'][$index] + ': ' + $label }
  if ($mark -eq 'done') { $block.Text = $markDone + '  ' + $display; $block.Foreground = $brushOk }
  elseif ($mark -eq 'failed') { $block.Text = $markFailed + '  ' + $display; $block.Foreground = $brushBad }
  elseif ($mark -eq 'doing') { $block.Text = $markDoing + '  ' + $display; $block.Foreground = $brushPlain; $block.FontWeight = [Windows.FontWeights]::SemiBold; return }
  else { $block.Text = $markTodo + '  ' + $display; $block.Foreground = $brushQuiet }
  $block.FontWeight = [Windows.FontWeights]::Normal
}

function Show-Steps([int]$current) {
  $ui.Steps.Children.Clear()
  $index = 0
  foreach ($label in $S.words['steps']) {
    $block = [Windows.Controls.TextBlock]::new()
    $block.Margin = [Windows.Thickness]::new(0, 0, 0, 12)
    $block.TextWrapping = [Windows.TextWrapping]::Wrap
    if ($index -lt $current) { $block.Text = $markDone + '  ' + [string]$label; $block.Foreground = $brushRailQuiet }
    elseif ($index -eq $current) { $block.Text = $markDoing + '  ' + [string]$label; $block.Foreground = $brushWhite; $block.FontWeight = [Windows.FontWeights]::SemiBold }
    else { $block.Text = $markTodo + '  ' + [string]$label; $block.Foreground = $brushRailQuiet }
    [void]$ui.Steps.Children.Add($block)
    $index = $index + 1
  }
}

# Ticks the password rule off as the person types. The password is
# looked at as bytes and wiped again at once.
function Update-Rules {
  $first = Read-Secret $ui.PassBox
  $second = Read-Secret $ui.AgainBox
  try {
    $long = $first.len -ge 8
    $digit = $false
    $symbol = $false
    for ($k = 0; $k -lt $first.len; $k++) {
      $b = $first.bytes[$k]
      if ($b -ge 0x30 -and $b -le 0x39) { $digit = $true }
      if (($b -ge 0x21 -and $b -le 0x2F) -or ($b -ge 0x3A -and $b -le 0x40) -or ($b -ge 0x5B -and $b -le 0x60) -or ($b -ge 0x7B -and $b -le 0x7E)) { $symbol = $true }
    }
    $same = ($first.len -gt 0) -and ($first.len -eq $second.len)
    if ($same) {
      for ($k = 0; $k -lt $first.len; $k++) {
        if ($first.bytes[$k] -ne $second.bytes[$k]) { $same = $false }
      }
    }
  } finally {
    Clear-Secret $first
    Clear-Secret $second
  }
  $labels = $S.words['ruleLabels']
  $states = @($long, $digit, $symbol, $same)
  for ($k = 0; $k -lt 4; $k++) {
    $mark = 'todo'
    if ($states[$k]) { $mark = 'done' }
    Set-Mark $ui[('Rule' + $k)] ([string]$labels[$k]) $mark
  }
  $S.ruleOk = $long -and $digit -and $symbol -and $same
}

function Clear-Passwords {
  $ui.PassBox.Clear()
  $ui.AgainBox.Clear()
}

function Show-Screen($m) {
  $S.confirmClose = [bool]$m['confirmClose']
  $S.panel = [string]$m['panel']
  $S.screen = [string]$m['name']
  Show-Steps ([int]$m['step'])
  $ui.Title.Text = [string]$m['title']
  $ui.Body.Text = [string]::Join([Environment]::NewLine + [Environment]::NewLine, [string[]]@($m['lines']))
  $ui.Problem.Text = ''
  $ui.ContentScroll.ScrollToTop()
  $ui.Rows.Children.Clear()
  $S.rows = @{}
  foreach ($row in $m['rows']) {
    $block = [Windows.Controls.TextBlock]::new()
    $block.Margin = [Windows.Thickness]::new(0, 0, 0, 8)
    $block.TextWrapping = [Windows.TextWrapping]::Wrap
    $label = [string]$row['label']
    Set-Mark $block $label ([string]$row['mark'])
    [void]$ui.Rows.Children.Add($block)
    $S.rows[[string]$row['id']] = @{ block = $block; label = $label }
  }
  if ($S.panel -eq 'about') { $ui.AboutPanel.Visibility = $visible } else { $ui.AboutPanel.Visibility = $collapsed; Clear-Passwords }
  if ($S.panel -eq 'options') { $ui.OptionsPanel.Visibility = $visible } else { $ui.OptionsPanel.Visibility = $collapsed }
  if ([bool]$m['details']) { $ui.Details.Visibility = $visible } else { $ui.Details.Visibility = $collapsed }
  if ($null -ne $m['next']) { $ui.NextButton.Content = [string]$m['next']; $ui.NextButton.Visibility = $visible; $ui.NextButton.IsEnabled = $true } else { $ui.NextButton.Visibility = $collapsed }
  if ($null -ne $m['back']) { $ui.BackButton.Content = [string]$m['back']; $ui.BackButton.Visibility = $visible; $ui.BackButton.IsEnabled = $true } else { $ui.BackButton.Visibility = $collapsed }
  if ($S.panel -eq 'about') { Update-Rules; [void]$ui.EmailBox.Focus() }
  elseif ($S.panel -eq 'options') { if ($ui.PhoneYes.IsChecked) { [void]$ui.PhoneYes.Focus() } else { [void]$ui.PhoneNo.Focus() } }
  elseif ($ui.NextButton.Visibility -eq $visible) { [void]$ui.NextButton.Focus() }
}

function Receive-Message($m) {
  $kind = [string]$m['t']
  if ($kind -eq 'init') {
    $w = $m['words']
    $S.words = $w
    $window.Title = [string]$w['windowTitle']
    $ui.Brand.Text = [string]$w['brand']
    $ui.EmailLabel.Text = [string]$w['emailLabel']
    $ui.PasswordLabel.Text = [string]$w['passwordLabel']
    $ui.AgainLabel.Text = [string]$w['againLabel']
    $ui.KeepLine.Text = [string]$w['keepLine']
    $ui.PhoneYes.Content = [string]$w['phoneYes']
    $ui.PhoneNo.Content = [string]$w['phoneNo']
    $ui.Details.Header = [string]$w['detailsLabel']
    [Windows.Automation.AutomationProperties]::SetName($ui.EmailBox, [string]$w['emailLabel'])
    [Windows.Automation.AutomationProperties]::SetName($ui.PassBox, [string]$w['passwordLabel'])
    [Windows.Automation.AutomationProperties]::SetName($ui.AgainBox, [string]$w['againLabel'])
  } elseif ($kind -eq 'screen') {
    Show-Screen $m
  } elseif ($kind -eq 'row') {
    $row = $S.rows[[string]$m['id']]
    if ($null -ne $row) { Set-Mark $row.block $row.label ([string]$m['mark']) }
  } elseif ($kind -eq 'line') {
    if ($ui.DetailsText.Text.Length -gt 400000) { $ui.DetailsText.Clear() }
    $ui.DetailsText.AppendText([string]$m['text'] + [Environment]::NewLine)
    $ui.DetailsText.ScrollToEnd()
  } elseif ($kind -eq 'problem') {
    $ui.Problem.Text = [string]$m['text']
    $ui.Problem.BringIntoView()
  } elseif ($kind -eq 'buttons') {
    $ui.NextButton.IsEnabled = [bool]$m['next']
    $ui.BackButton.IsEnabled = [bool]$m['back']
  } elseif ($kind -eq 'end') {
    $S.ended = $true
    $window.Close()
  } else {
    $S.ended = $true
    $window.Close()
  }
}

function Start-Read {
  $S.task = $stdin.ReadAsync($S.buf, $S.have, $S.buf.Length - $S.have)
}

# Reads whatever the setup program has sent, a frame at a time. A
# frame of a kind the window does not take, or one that is too long,
# closes the window.
function Read-Frames {
  if ($null -eq $S.task -or -not $S.task.IsCompleted) { return }
  $got = 0
  if (-not $S.task.IsFaulted -and -not $S.task.IsCanceled) { $got = $S.task.Result }
  $S.task = $null
  if ($got -le 0) { $S.ended = $true; $window.Close(); return }
  $S.have = $S.have + $got
  while ($S.have -ge 5) {
    $length = ([int]$S.buf[1] -shl 24) -bor ([int]$S.buf[2] -shl 16) -bor ([int]$S.buf[3] -shl 8) -bor [int]$S.buf[4]
    if ($S.buf[0] -ne 1 -or $length -lt 0 -or $length -gt 65536) { $S.ended = $true; $window.Close(); return }
    if ($S.have -lt (5 + $length)) { break }
    $text = $utf8.GetString($S.buf, 5, $length)
    $rest = $S.have - 5 - $length
    if ($rest -gt 0) { [Array]::Copy($S.buf, 5 + $length, $S.buf, 0, $rest) }
    $S.have = $rest
    Receive-Message ($json.DeserializeObject($text))
    if ($S.ended) { return }
  }
  Start-Read
}

function Send-Wait($message) {
  $ui.NextButton.IsEnabled = $false
  $ui.BackButton.IsEnabled = $false
  Send-Message $message
}

$ui.PassBox.Add_PasswordChanged({ Update-Rules })
$ui.AgainBox.Add_PasswordChanged({ Update-Rules })

$ui.NextButton.Add_Click({
  if ($S.panel -eq 'about') {
    $secret = Read-Secret $ui.PassBox
    try {
      $ui.NextButton.IsEnabled = $false
      $ui.BackButton.IsEnabled = $false
      Send-Frame 2 $secret.bytes $secret.len
    } finally {
      Clear-Secret $secret
    }
    $again = Read-Secret $ui.AgainBox
    try { Send-Frame 2 $again.bytes $again.len } finally { Clear-Secret $again }
    $email = [string]$ui.EmailBox.Text
    Clear-Passwords
    Send-Message @{ t = 'about'; email = $email }
  } elseif ($S.panel -eq 'options') {
    Send-Wait @{ t = 'options'; phone = [bool]$ui.PhoneYes.IsChecked }
  } else {
    Send-Wait @{ t = 'next' }
  }
})

$ui.BackButton.Add_Click({ Send-Wait @{ t = 'back' } })

$window.Add_Closing({
  param($source, $e)
  if ($S.ended) { return }
  if ($S.confirmClose) {
    $answer = [Windows.MessageBox]::Show($window, [string]$S.words['closeQuestion'], [string]$S.words['closeTitle'], [Windows.MessageBoxButton]::YesNo, [Windows.MessageBoxImage]::Question)
    if ($answer -ne [Windows.MessageBoxResult]::Yes) { $e.Cancel = $true; return }
  }
  $S.ended = $true
  try { Send-Message @{ t = 'closing' } } catch { }
})

$timer = [Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromMilliseconds(40)
$timer.Add_Tick({
  try { Read-Frames } catch { $S.ended = $true; $window.Close() }
})

$window.Add_ContentRendered({ [void]$window.Activate() })

Send-Message @{
  t = 'hello'
  windowsDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
  systemDir = [Environment]::SystemDirectory
  modulePath = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  languageMode = [string]$ExecutionContext.SessionState.LanguageMode
}
Start-Read
$timer.Start()
[void]$window.ShowDialog()
$timer.Stop()
Clear-Passwords
`;
