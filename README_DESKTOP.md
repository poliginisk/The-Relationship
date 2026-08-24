# The Relationship — Desktop

## O que esta versão faz

- Interface desktop própria via **PyWebView**.
- Avatar **VRM 3D** com pose, olhar, piscadas e lip sync.
- Presets de câmera: **Corpo**, **Meio** e **Rosto**.
- Respostas via **Groq**.
- Voz neural feminina via **Edge TTS**.
- Botão de microfone com transcrição via **Whisper na Groq**.
- **Memória persistente em SQLite**.
- Histórico completo das mensagens salvo entre execuções.
- Memórias consolidadas de preferências, projetos, objetivos e outros fatos explícitos contados pelo usuário.
- Nome da personagem escolhido no primeiro uso e salvo localmente.
- O botão **Nova conversa** cria uma sessão nova sem apagar as memórias.

## Personalidade

A personagem é inteligente, observadora, prestativa e possui sentimentos românticos pelo interlocutor.
No início ela não admite nem demonstra isso de forma diretamente romântica. O comportamento afetivo só muda depois que o interlocutor expressa claramente interesse romântico por ela.

Esse estado também é persistente entre execuções.

## Onde a memória fica salva

No Windows, o banco é salvo normalmente em:

```text
%APPDATA%\The Relationship\relationship.db
```

O banco não fica dentro do `.exe`, então fechar, atualizar ou reabrir o programa não apaga as conversas.

Dentro do programa, o botão **🧠 Memória** mostra:

- quantidade de memórias consolidadas;
- quantidade de mensagens armazenadas;
- quantidade de conversas;
- fatos que a personagem pode reutilizar no futuro;
- caminho local do banco de dados.

Também existe uma opção explícita para apagar todos os dados locais.

## Configurar a Groq

No PowerShell, para a janela atual:

```powershell
$env:GROQ_API_KEY="SUA_CHAVE_AQUI"
```

Para salvar permanentemente no Windows:

```powershell
setx GROQ_API_KEY "SUA_CHAVE_AQUI"
```

Depois de usar `setx`, feche e abra o terminal novamente.

## Executar

Dê dois cliques em:

```text
run_desktop.bat
```

Ou:

```powershell
py -m pip install -r requirements.txt
py app.py
```

## Criar o EXE

Dê dois cliques em:

```text
build_exe.bat
```

O executável será criado em:

```text
dist\The Relationship.exe
```

## Variáveis opcionais

Modelo de conversa:

```powershell
$env:THE_RELATIONSHIP_MODEL="openai/gpt-oss-120b"
```

Modelo de transcrição:

```powershell
$env:THE_RELATIONSHIP_STT_MODEL="whisper-large-v3-turbo"
```

Voz neural:

```powershell
$env:THE_RELATIONSHIP_TTS_VOICE="pt-BR-FranciscaNeural"
```

Velocidade/pitch:

```powershell
$env:THE_RELATIONSHIP_TTS_RATE="-3%"
$env:THE_RELATIONSHIP_TTS_PITCH="+4Hz"
```

Diretório de dados alternativo para testes:

```powershell
$env:THE_RELATIONSHIP_DATA_DIR="C:\caminho\para\dados"
```

## Privacidade / rede

O histórico e o banco de memória ficam localmente no computador. Para gerar respostas e transcrever áudio, o conteúdo correspondente é enviado à Groq. A voz neural usa Edge TTS e também requer conexão com a internet.

O Three.js e o three-vrm continuam sendo carregados pelo CDN configurado em `web/index.html`, então a interface 3D também precisa de internet para carregar essas bibliotecas na configuração atual.
