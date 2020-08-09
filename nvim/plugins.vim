call plug#begin('~/.vim/plugged')

Plug 'scrooloose/nerdtree'
Plug 'norcalli/nvim-colorizer.lua'
Plug 'sheerun/vim-polyglot'
Plug 'neoclide/coc.nvim', {'branch': 'release'}
Plug 'vim-airline/vim-airline'
Plug 'vim-airline/vim-airline-themes'
Plug 'chriskempson/base16-vim'
Plug 'tpope/vim-commentary'
Plug 'tpope/vim-fugitive'
Plug 'Xuyuanp/nerdtree-git-plugin'
Plug 'mattn/emmet-vim'
Plug 'michaeljsmith/vim-indent-object'
Plug 'kamykn/spelunker.vim'
Plug 'junegunn/fzf', { 'dir': '~/.fzf', 'do': './install --all' }
Plug 'junegunn/fzf.vim'
Plug 'tpope/vim-abolish'
Plug 'Raimondi/delimitMate'
Plug 'jeetsukumaran/vim-indentwise'
Plug 'zacacollier/vim-javascript-sql', { 'branch': 'add-typescript-support' }
Plug 'junegunn/goyo.vim'
Plug 'vimwiki/vimwiki'
Plug 'tpope/vim-unimpaired'
Plug 'tpope/vim-dispatch'
Plug 'mzlogin/vim-markdown-toc'
Plug 'Asheq/close-buffers.vim'
Plug 'mzlogin/vim-markdown-toc'
Plug 'shmup/vim-sql-syntax'
Plug 'yysfire/vimwiki2markdown'
Plug 'lifepillar/pgsql.vim'
Plug 'bronson/vim-trailing-whitespace'
Plug 'mbbill/undotree'
Plug 'simnalamburt/vim-mundo'
Plug 'yardnsm/vim-import-cost', { 'do': 'npm install' }
Plug 'tpope/vim-dadbod'
Plug 'acamso/vim-dadbod-ui'

call plug#end()

nmap <leader>s <Plug>(DBUI_SaveQuery)
let g:db_ui_auto_execute_table_helpers=1
