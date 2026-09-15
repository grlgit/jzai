'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Settings, LogOut, Moon, Sun } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator,
} from '../ui/dropdown-menu'
import { useTheme } from 'next-themes'
const isLocal = process.env.NEXT_PUBLIC_MODE === 'local'

export function SidenavUserMenu() {
  const router = useRouter()
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => { setMounted(true) }, [])

  const handleSignOut = async () => {
    // Clear local token and redirect
    localStorage.removeItem('jz_token')
    router.push('/login')
  }

  const initials = 'U'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 w-full px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors cursor-pointer">
          <div className="h-5 w-5 bg-muted border border-border rounded flex items-center justify-center shrink-0">
            <span className="text-[8px] font-medium">{initials}</span>
          </div>
          <span className="truncate">用户</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-48">
        <DropdownMenuItem onClick={() => router.push('/settings')}>
          <Settings className="mr-2 h-4 w-4" />
          设置
        </DropdownMenuItem>
        {mounted && (
          <DropdownMenuItem onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? (
              <><Sun className="mr-2 h-4 w-4" />浅色模式</>
            ) : (
              <><Moon className="mr-2 h-4 w-4" />深色模式</>
            )}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut}>
          <LogOut className="mr-2 h-4 w-4" />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
